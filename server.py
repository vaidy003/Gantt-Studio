from __future__ import annotations

import csv
import json
import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.getenv("GANTT_DATA_DIR", str(ROOT / "data")))
DB_PATH = DATA_DIR / "gantt.db"
SEED_CSV_PATH = ROOT / "data" / "source_seed.csv"


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def setup_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with closing(get_connection()) as connection:
        connection.executescript(
            """
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              assignee_email TEXT NOT NULL,
              start_date TEXT NOT NULL,
              end_date TEXT NOT NULL,
              parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
              order_index INTEGER NOT NULL,
              source_task_id TEXT,
              source_subtask_id TEXT,
              source_subsubtask_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            """
        )
        ensure_manual_date_columns(connection)
        row_count = connection.execute("SELECT COUNT(*) AS count FROM tasks").fetchone()["count"]
        if row_count == 0:
            seed_from_csv(connection, SEED_CSV_PATH)
        normalize_two_level_hierarchy(connection)
        refresh_all_parent_dates(connection)
        connection.commit()


def ensure_manual_date_columns(connection: sqlite3.Connection) -> None:
    columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(tasks)").fetchall()
    }

    if "manual_start_date" not in columns:
        connection.execute("ALTER TABLE tasks ADD COLUMN manual_start_date TEXT NOT NULL DEFAULT ''")
    if "manual_end_date" not in columns:
        connection.execute("ALTER TABLE tasks ADD COLUMN manual_end_date TEXT NOT NULL DEFAULT ''")

    connection.execute(
        """
        UPDATE tasks
        SET manual_start_date = start_date,
            manual_end_date = end_date
        WHERE manual_start_date = '' AND manual_end_date = ''
        """
    )


def seed_from_csv(connection: sqlite3.Connection, csv_path: Path) -> None:
    if not csv_path.exists():
        return

    with csv_path.open(newline="", encoding="utf-8") as handle:
        seed_from_reader(connection, csv.DictReader(handle))


def seed_from_reader(connection: sqlite3.Connection, reader: csv.DictReader) -> None:
    current_top_db_id: int | None = None
    current_sub_db_id: int | None = None
    sibling_counters: dict[int | None, int] = {}

    for row in reader:
        task_id = (row.get("Task ID") or "").strip()
        subtask_id = (row.get("SubTask ID") or "").strip()
        subsubtask_id = (row.get("Sub Sub Task ID") or "").strip()
        title = (row.get("Task Name") or "").strip()
        assignee = (row.get("Assignee Email") or "").strip() or "prasad@aeee.in"
        start_date = normalize_date(row.get("Start Date"))
        end_date = normalize_date(row.get("End Date"))

        is_top_level = bool(task_id)
        if not title:
            continue
        if not is_top_level and (not start_date or not end_date):
            continue

        if task_id:
            parent_id = None
        elif subtask_id:
            parent_id = current_top_db_id
        else:
            parent_id = current_top_db_id

        sibling_counters[parent_id] = sibling_counters.get(parent_id, 0) + 1
        order_index = sibling_counters[parent_id]
        timestamp = utc_now()

        cursor = connection.execute(
            """
            INSERT INTO tasks (
              title, assignee_email, start_date, end_date, parent_id, order_index,
              source_task_id, source_subtask_id, source_subsubtask_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                title,
                assignee,
                start_date or "",
                end_date or "",
                parent_id,
                order_index,
                task_id or None,
                subtask_id or None,
                subsubtask_id or None,
                timestamp,
                timestamp,
            ),
        )
        connection.execute(
            """
            UPDATE tasks
            SET manual_start_date = ?, manual_end_date = ?
            WHERE id = ?
            """,
            (start_date or "", end_date or "", cursor.lastrowid),
        )
        inserted_id = cursor.lastrowid

        if task_id:
            current_top_db_id = inserted_id
            current_sub_db_id = None
        elif subtask_id:
            current_sub_db_id = inserted_id


def import_csv_text(connection: sqlite3.Connection, csv_text: str) -> int:
    try:
        reader = csv.DictReader(csv_text.splitlines())
    except csv.Error as error:
        raise ValueError(f"Invalid CSV: {error}") from error

    required_headers = {"Task Name", "Start Date", "End Date"}
    headers = set(reader.fieldnames or [])
    if not required_headers.issubset(headers):
        raise ValueError("CSV must include Task Name, Start Date, and End Date columns.")

    connection.execute("DELETE FROM tasks")
    seed_from_reader(connection, reader)
    normalize_two_level_hierarchy(connection)
    refresh_all_parent_dates(connection)
    row_count = connection.execute("SELECT COUNT(*) AS count FROM tasks").fetchone()["count"]
    if row_count == 0:
        raise ValueError("CSV import produced no valid tasks.")
    connection.commit()
    return row_count


def normalize_date(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def fetch_tasks(connection: sqlite3.Connection) -> list[dict]:
    rows = connection.execute(
        """
        SELECT id, title, assignee_email, start_date, end_date, manual_start_date, manual_end_date, parent_id, order_index,
               source_task_id, source_subtask_id, source_subsubtask_id
        FROM tasks
        ORDER BY parent_id IS NOT NULL, COALESCE(parent_id, id), order_index, id
        """
    ).fetchall()

    items = [dict(row) for row in rows]
    by_parent: dict[int | None, list[dict]] = {}
    for item in items:
        by_parent.setdefault(item["parent_id"], []).append(item)

    for children in by_parent.values():
        children.sort(key=lambda item: (item["order_index"], item["id"]))

    def build(parent_id: int | None, depth: int = 0) -> list[dict]:
        built = []
        for node in by_parent.get(parent_id, []):
            item = {
                **node,
                "depth": depth,
                "children": build(node["id"], depth + 1),
            }
            built.append(item)
        return built

    return build(None)


def reset_to_seed(connection: sqlite3.Connection) -> None:
    connection.execute("DELETE FROM tasks")
    seed_from_csv(connection, SEED_CSV_PATH)
    normalize_two_level_hierarchy(connection)
    refresh_all_parent_dates(connection)
    connection.commit()


def get_task(connection: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise KeyError(f"Task {task_id} not found")
    return row


def sibling_rows(connection: sqlite3.Connection, parent_id: int | None) -> list[sqlite3.Row]:
    return connection.execute(
        "SELECT * FROM tasks WHERE parent_id IS ? ORDER BY order_index, id", (parent_id,)
    ).fetchall()


def renumber_siblings(connection: sqlite3.Connection, parent_id: int | None) -> None:
    siblings = sibling_rows(connection, parent_id)
    for index, sibling in enumerate(siblings, start=1):
        connection.execute(
            "UPDATE tasks SET order_index = ?, updated_at = ? WHERE id = ?",
            (index, utc_now(), sibling["id"]),
        )


def parent_depth(connection: sqlite3.Connection, parent_id: int | None) -> int:
    depth = 0
    current_id = parent_id
    while current_id is not None:
        row = get_task(connection, current_id)
        depth += 1
        current_id = row["parent_id"]
    return depth


def normalize_date_or_blank(value: str | None) -> str:
    return normalize_date(value) or ""


def validate_task_dates(start_date: str, end_date: str, *, require_dates: bool) -> None:
    if require_dates and (not start_date or not end_date):
        raise ValueError("Start date and end date are required for subtasks.")
    if (start_date and not end_date) or (end_date and not start_date):
        raise ValueError("Start date and end date must both be set or both be blank.")
    if start_date and end_date and start_date > end_date:
        raise ValueError("Start date must be before or equal to end date.")


def refresh_parent_dates(connection: sqlite3.Connection, parent_id: int | None) -> None:
    if parent_id is None:
        return

    parent = get_task(connection, parent_id)
    children = connection.execute(
        """
        SELECT start_date, end_date
        FROM tasks
        WHERE parent_id = ? AND start_date <> '' AND end_date <> ''
        ORDER BY start_date, end_date
        """,
        (parent_id,),
    ).fetchall()

    if children:
        effective_start = min(child["start_date"] for child in children)
        effective_end = max(child["end_date"] for child in children)
    else:
        effective_start = parent["manual_start_date"] or ""
        effective_end = parent["manual_end_date"] or ""

    connection.execute(
        "UPDATE tasks SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?",
        (effective_start, effective_end, utc_now(), parent_id),
    )


def refresh_all_parent_dates(connection: sqlite3.Connection) -> None:
    parent_ids = connection.execute(
        "SELECT id FROM tasks WHERE parent_id IS NULL ORDER BY order_index, id"
    ).fetchall()
    for row in parent_ids:
        refresh_parent_dates(connection, row["id"])


def normalize_two_level_hierarchy(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        "SELECT id, parent_id, order_index FROM tasks ORDER BY id"
    ).fetchall()

    for row in rows:
        depth = parent_depth(connection, row["parent_id"])
        if depth <= 1:
            continue

        parent = get_task(connection, row["parent_id"])
        top_parent_id = parent["parent_id"]
        next_order = connection.execute(
            "SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM tasks WHERE parent_id IS ?",
            (top_parent_id,),
        ).fetchone()["next_order"]

        connection.execute(
            "UPDATE tasks SET parent_id = ?, order_index = ?, updated_at = ? WHERE id = ?",
            (top_parent_id, next_order, utc_now(), row["id"]),
        )

    root_rows = connection.execute("SELECT id FROM tasks WHERE parent_id IS NULL ORDER BY order_index, id").fetchall()
    for root in root_rows:
        renumber_siblings(connection, root["id"])
    renumber_siblings(connection, None)


def create_task(connection: sqlite3.Connection, payload: dict) -> dict:
    title = payload["title"].strip()
    assignee = payload.get("assignee_email", "").strip() or "prasad@aeee.in"
    start_date = normalize_date_or_blank(payload.get("start_date"))
    end_date = normalize_date_or_blank(payload.get("end_date"))
    parent_id = payload.get("parent_id")
    parent_id = int(parent_id) if parent_id not in (None, "", "null") else None

    if not title:
        raise ValueError("Title is required.")
    validate_task_dates(start_date, end_date, require_dates=parent_id is not None)
    if parent_depth(connection, parent_id) >= 2:
        raise ValueError("Sub Task is the deepest supported level.")

    next_order = connection.execute(
        "SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM tasks WHERE parent_id IS ?",
        (parent_id,),
    ).fetchone()["next_order"]

    timestamp = utc_now()
    cursor = connection.execute(
        """
        INSERT INTO tasks (
          title, assignee_email, start_date, end_date, manual_start_date, manual_end_date,
          parent_id, order_index, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (title, assignee, start_date, end_date, start_date, end_date, parent_id, next_order, timestamp, timestamp),
    )
    if parent_id is not None:
        refresh_parent_dates(connection, parent_id)
    connection.commit()
    return dict(get_task(connection, cursor.lastrowid))


def update_task(connection: sqlite3.Connection, task_id: int, payload: dict) -> dict:
    task = get_task(connection, task_id)
    title = payload["title"].strip()
    assignee = payload.get("assignee_email", "").strip() or "prasad@aeee.in"
    start_date = normalize_date_or_blank(payload.get("start_date"))
    end_date = normalize_date_or_blank(payload.get("end_date"))
    parent_id = payload.get("parent_id")
    parent_id = int(parent_id) if parent_id not in (None, "", "null") else None

    if not title:
        raise ValueError("Title is required.")
    validate_task_dates(start_date, end_date, require_dates=parent_id is not None)
    if parent_id == task_id:
        raise ValueError("Task cannot be its own parent.")
    if parent_depth(connection, parent_id) >= 2:
        raise ValueError("Sub Task is the deepest supported level.")
    if task["parent_id"] is None and parent_id is not None:
        raise ValueError("Top-level tasks cannot be converted into subtasks.")

    timestamp = utc_now()
    connection.execute(
        """
        UPDATE tasks
        SET title = ?, assignee_email = ?, start_date = ?, end_date = ?,
            manual_start_date = ?, manual_end_date = ?, parent_id = ?, updated_at = ?
        WHERE id = ?
        """,
        (title, assignee, start_date, end_date, start_date, end_date, parent_id, timestamp, task_id),
    )

    if task["parent_id"] != parent_id:
        next_order = connection.execute(
            "SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM tasks WHERE parent_id IS ?",
            (parent_id,),
        ).fetchone()["next_order"]
        connection.execute(
            "UPDATE tasks SET order_index = ?, updated_at = ? WHERE id = ?",
            (next_order, timestamp, task_id),
        )
        renumber_siblings(connection, task["parent_id"])
        renumber_siblings(connection, parent_id)

    if parent_id is None:
        refresh_parent_dates(connection, task_id)
    else:
        refresh_parent_dates(connection, parent_id)
    if task["parent_id"] != parent_id:
        refresh_parent_dates(connection, task["parent_id"])

    connection.commit()
    return dict(get_task(connection, task_id))


def delete_task(connection: sqlite3.Connection, task_id: int) -> str:
    task = get_task(connection, task_id)
    if task["parent_id"] is None:
        raise ValueError("Top-level tasks cannot be deleted.")

    title = task["title"]
    parent_id = task["parent_id"]
    connection.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    renumber_siblings(connection, parent_id)
    refresh_parent_dates(connection, parent_id)
    connection.commit()
    return title


def move_task(connection: sqlite3.Connection, task_id: int, direction: str) -> None:
    task = get_task(connection, task_id)
    siblings = sibling_rows(connection, task["parent_id"])
    index = next(i for i, row in enumerate(siblings) if row["id"] == task_id)

    if direction == "up" and index > 0:
        sibling = siblings[index - 1]
    elif direction == "down" and index < len(siblings) - 1:
        sibling = siblings[index + 1]
    else:
        return

    connection.execute(
        "UPDATE tasks SET order_index = ?, updated_at = ? WHERE id = ?",
        (sibling["order_index"], utc_now(), task_id),
    )
    connection.execute(
        "UPDATE tasks SET order_index = ?, updated_at = ? WHERE id = ?",
        (task["order_index"], utc_now(), sibling["id"]),
    )
    renumber_siblings(connection, task["parent_id"])
    connection.commit()


def demote_task(connection: sqlite3.Connection, task_id: int) -> None:
    task = get_task(connection, task_id)
    old_parent_id = task["parent_id"]
    siblings = sibling_rows(connection, task["parent_id"])
    index = next(i for i, row in enumerate(siblings) if row["id"] == task_id)
    if index == 0:
        return

    new_parent = siblings[index - 1]
    if parent_depth(connection, new_parent["id"]) >= 2:
        return

    new_order = connection.execute(
        "SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM tasks WHERE parent_id = ?",
        (new_parent["id"],),
    ).fetchone()["next_order"]

    connection.execute(
        "UPDATE tasks SET parent_id = ?, order_index = ?, updated_at = ? WHERE id = ?",
        (new_parent["id"], new_order, utc_now(), task_id),
    )
    renumber_siblings(connection, old_parent_id)
    renumber_siblings(connection, new_parent["id"])
    refresh_parent_dates(connection, old_parent_id)
    refresh_parent_dates(connection, new_parent["id"])
    connection.commit()


def promote_task(connection: sqlite3.Connection, task_id: int) -> None:
    task = get_task(connection, task_id)
    if task["parent_id"] is None:
        return

    old_parent_id = task["parent_id"]
    parent = get_task(connection, task["parent_id"])
    new_parent_id = parent["parent_id"]
    new_siblings = sibling_rows(connection, new_parent_id)
    parent_index = next(i for i, row in enumerate(new_siblings) if row["id"] == parent["id"])

    for sibling in reversed(new_siblings[parent_index + 1 :]):
        connection.execute(
            "UPDATE tasks SET order_index = order_index + 1, updated_at = ? WHERE id = ?",
            (utc_now(), sibling["id"]),
        )

    connection.execute(
        "UPDATE tasks SET parent_id = ?, order_index = ?, updated_at = ? WHERE id = ?",
        (new_parent_id, parent["order_index"] + 1, utc_now(), task_id),
    )

    renumber_siblings(connection, old_parent_id)
    renumber_siblings(connection, new_parent_id)
    refresh_parent_dates(connection, old_parent_id)
    refresh_parent_dates(connection, new_parent_id)
    connection.commit()


class GanttRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/tasks":
            with closing(get_connection()) as connection:
                payload = {"tasks": fetch_tasks(connection)}
            self.send_json(payload)
            return

        if parsed.path == "/health":
            self.send_json({"ok": True})
            return

        if parsed.path == "/":
            self.path = "/index.html"

        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length) if content_length else b"{}"

        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        try:
            with closing(get_connection()) as connection:
                if parsed.path == "/api/tasks":
                    task = create_task(connection, payload)
                    self.send_json(task, status=HTTPStatus.CREATED)
                    return

                if parsed.path.endswith("/update"):
                    task_id = int(parsed.path.split("/")[-2])
                    task = update_task(connection, task_id, payload)
                    self.send_json(task)
                    return

                if parsed.path == "/api/import":
                    imported_count = import_csv_text(connection, payload.get("csv_text", ""))
                    self.send_json({"ok": True, "count": imported_count})
                    return

                if parsed.path == "/api/reset":
                    reset_to_seed(connection)
                    self.send_json({"ok": True})
                    return

                if parsed.path.endswith("/delete"):
                    task_id = int(parsed.path.split("/")[-2])
                    title = delete_task(connection, task_id)
                    self.send_json({"ok": True, "title": title})
                    return

                if parsed.path.endswith("/move"):
                    task_id = int(parsed.path.split("/")[-2])
                    move_task(connection, task_id, payload.get("direction", ""))
                    self.send_json({"ok": True})
                    return

                if parsed.path.endswith("/indent"):
                    task_id = int(parsed.path.split("/")[-2])
                    action = payload.get("action")
                    if action == "demote":
                        demote_task(connection, task_id)
                    elif action == "promote":
                        promote_task(connection, task_id)
                    self.send_json({"ok": True})
                    return
        except (ValueError, KeyError) as error:
            self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    setup_database()
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8017"))
    server = ThreadingHTTPServer((host, port), GanttRequestHandler)
    print(f"Gantt Studio running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
