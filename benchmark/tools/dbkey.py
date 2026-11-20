import sqlite3, sys

db = sys.argv[1] if len(sys.argv) > 1 else "openagent.db"
c = sqlite3.connect(db)
cur = c.cursor()
cur.execute("select owner, name, model_provider, external_api_key, storage_provider, storage_subpath, prompt, tools, skills from store")
for row in cur.fetchall():
    print(dict(zip(["owner","name","model_provider","external_api_key","storage_provider","storage_subpath","prompt","tools","skills"], row)))
