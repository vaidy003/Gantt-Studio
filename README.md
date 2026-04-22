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

## Railway Deploy

This app can be deployed on Railway with a mounted volume for the SQLite database.

### Required setup

- Create a Railway project from this GitHub repo
- Set the service root to `gantt-studio`
- Attach a volume and mount it at `/data`
- Add environment variable:

```bash
GANTT_DATA_DIR=/data
```

### Runtime

- Railway supplies `PORT`
- The app binds to `0.0.0.0`
- Seed CSV still comes from the repo at `data/source_seed.csv`

### Important

- If you do not attach a volume, your SQLite data will not persist reliably across deploys/restarts.
