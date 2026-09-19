#!/bin/bash
pg_dump "$MAI_DB_URL" > backup.sql
node ../server.js ${EXTRA_FLAGS}
python3 ../tools/job.py
