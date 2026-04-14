# Gantt Studio

Fresh implementation of the Gantt app with:

- SQLite-backed persistence
- CSV seed import on first run
- add task modal
- collapse and expand
- assignee on hover
- reorder up and down
- promote and demote hierarchy

## Run

```bash
cd /Users/prasad/Desktop/Temp/TestCodex/GanttMaker/gantt-studio
python3 server.py
```

Open:

[http://127.0.0.1:8017](http://127.0.0.1:8017)

## Notes

- The database is created at `data/gantt.db`.
- Initial seed data comes from `data/source_seed.csv`.
- Seed import only happens when the database is empty.
