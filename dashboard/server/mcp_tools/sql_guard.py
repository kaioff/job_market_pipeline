"""Validation for the MCP `run_sql` tool, which runs model-written SQL.

This is defence in depth, not the security boundary: the real guarantee is
MCP_DATABRICKS_TOKEN belonging to a principal with only SELECT grants on the
gold/silver schemas. These checks catch mistakes early with a readable error
and keep queries away from everything else in the workspace even when that
token is broader than it should be.
"""

import re

FORBIDDEN = [
    "insert", "update", "delete", "merge", "drop", "create", "alter",
    "truncate", "grant", "revoke", "copy", "optimize", "vacuum", "set",
    "reset", "use", "call", "refresh", "cache", "uncache", "msck", "restore",
    "clone", "put", "get", "remove", "list", "add", "install", "execute",
    "comment", "analyze",
]

# Table-valued functions that read outside the allowed schemas.
FORBIDDEN_FUNCTIONS = [
    "read_files", "read_kafka", "read_kinesis", "read_pubsub", "read_pulsar",
    "read_state_metadata", "read_statestore", "cloud_files", "http_request",
    "ai_query", "java_method", "reflect", "secret",
]


def _mask(sql: str) -> str:
    """Blank out string literals and comments so keyword checks can't be fooled."""
    sql = re.sub(r"--[^\n]*", " ", sql)
    sql = re.sub(r"/\*[\s\S]*?\*/", " ", sql)
    sql = re.sub(r"'(?:[^'\\]|\\.|'')*'", "''", sql)
    return re.sub(r'"(?:[^"\\]|\\.)*"', '""', sql)


def guard_sql(raw: str, allowed: list[str], max_rows: int) -> tuple[str | None, str | None]:
    """Returns (sql ready to run with a row cap, None) or (None, error).

    `allowed` is the list of "catalog.schema" names queries may touch.
    """
    sql = re.sub(r";\s*$", "", str(raw or "").strip())
    if not sql:
        return None, "Empty query."
    if len(sql) > 20000:
        return None, "Query too long (max 20000 characters)."

    # FROM inside extract/trim/substring/overlay isn't a table reference.
    masked = re.sub(
        r"\b(extract|trim|substring|overlay)\s*\([^()]*\)", r"\1()", _mask(sql).lower()
    )
    allowed_list = ", ".join(allowed)

    if ";" in masked:
        return None, "Only a single statement is allowed."
    if not re.match(r"^\s*(select|with)\b", masked):
        return None, "Only read-only SELECT / WITH queries are allowed."
    # Backticks could smuggle identifiers past the name checks below.
    if "`" in masked:
        return None, "Backtick-quoted identifiers are not allowed."

    for word in FORBIDDEN:
        if re.search(rf"\b{word}\b", masked):
            return None, f'Keyword "{word.upper()}" is not allowed.'
    for fn in FORBIDDEN_FUNCTIONS:
        if re.search(rf"\b{fn}\s*\(", masked):
            return None, f'Function "{fn}" is not allowed.'
    # Path-based reads like SELECT * FROM delta.`/path` or parquet.`s3://...`
    if re.search(r"\b(delta|parquet|csv|json|text|orc|avro|binaryfile)\s*\.", masked):
        return None, "Reading files by path is not allowed."

    # Every table must be fully qualified as catalog.schema.table in an
    # allowed schema; bare/two-part names would resolve against whatever the
    # session defaults to.
    refs = re.findall(r"\b(?:from|join)\s+([a-z_][\w.]*)", masked)
    cte_names = set(re.findall(r"(?:\bwith\b|,)\s*([a-z_]\w*)\s+as\s*\(", masked))
    for ref in refs:
        if ref in cte_names:
            continue
        parts = ref.split(".")
        if len(parts) != 3:
            return None, (
                f'Table "{ref}" must be fully qualified as catalog.schema.table '
                f"(allowed schemas: {allowed_list})."
            )
        if f"{parts[0]}.{parts[1]}" not in allowed:
            return None, f'Schema "{parts[0]}.{parts[1]}" is not allowed (allowed: {allowed_list}).'

    # Any other three-part name (e.g. in a scalar subquery via a comma join)
    # must also be in an allowed schema.
    for catalog, schema, _ in re.findall(r"\b([a-z_]\w*)\.([a-z_]\w*)\.([a-z_]\w*)\b", masked):
        if f"{catalog}.{schema}" not in allowed:
            return None, f'Schema "{catalog}.{schema}" is not allowed (allowed: {allowed_list}).'

    # Comma joins (FROM a, b) bypass the FROM/JOIN capture above.
    if re.search(r"\bfrom\s+[\w.]+(?:\s+(?:as\s+)?[a-z_]\w*)?\s*,", masked):
        return None, "Comma joins are not allowed; use explicit JOIN ... ON."

    return f"SELECT * FROM (\n{sql}\n) AS mcp_q LIMIT {max_rows}", None
