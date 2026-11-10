#!/usr/bin/env python3
"""Import the Founder Hub SQL contract into schemas owned by the Shots database."""
import argparse
import hashlib
import json
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("hub", type=Path)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
destination = Path(__file__).resolve().parents[1] / "server/founderhubmigrations"
schemas = {"public": "founder_hub", "private": "founder_hub_private", "auth": "founder_hub_identity", "stripe": "founder_hub_billing"}
roles = {name: "shots_hub_" + name for name in ["anon", "authenticated", "service_role", "supabase_auth_admin", "authenticator"]}
manifest = {}
for source in sorted((args.hub / "supabase/migrations").glob("*.sql")):
    original = source.read_text()
    sql = original
    for before, after in schemas.items():
        sql = re.sub(rf'\b{before}\.', after + '.', sql)
        sql = sql.replace(f'"{before}".', f'"{after}".')
        sql = re.sub(rf'(?i)(\bSCHEMA(?: IF NOT EXISTS)?\s+)"?{before}"?(?=\s|;)', lambda match: match[1] + after, sql)
    # This is a domain in the disposable-email list, not a schema reference.
    sql = sql.replace("('founder_hub.usa.com')", "('public.usa.com')")
    for before, after in roles.items():
        sql = re.sub(rf'\b{before}\b', after, sql)
    sql = sql.replace("VALUES (v_id, 'shots_hub_authenticated', 'shots_hub_authenticated',", "VALUES (v_id, 'authenticated', 'shots_hub_authenticated',")
    sql = sql.replace("ALTER ROLE shots_hub_authenticator SET pgrst.db_pre_request = 'founder_hub_private.check_shots_request';", "-- The private PostgREST runtime configures founder_hub_private.check_shots_request.")
    sql = re.sub(r'(?i)CREATE SCHEMA IF NOT EXISTS (founder_hub(?:_private|_identity|_billing)?);', r'-- Schema \1 is provisioned by the privileged bootstrap.', sql)
    sql = re.sub(r'(?i)CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;', '-- pgcrypto is provisioned by the privileged bootstrap.', sql)
    sql = re.sub(r'(?i)OWNER TO postgres;', 'OWNER TO shots_hub_owner;', sql)
    output = destination / "sql" / source.name
    if args.check:
        if not output.exists() or output.read_text() != sql:
            raise SystemExit(f"Founder Hub migration drift: {source.name}")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(sql)
    manifest[source.name] = hashlib.sha256(original.encode()).hexdigest()
if not manifest:
    raise SystemExit("No Founder Hub migrations found")
license_text = (args.hub / "LICENSE").read_text()
if args.check:
    if (destination / "source.json").read_text() != json.dumps(manifest, indent=2) + "\n":
        raise SystemExit("Founder Hub migration inventory changed")
else:
    (destination / "source.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "LICENSE").write_text(license_text)
print(f"{'Verified' if args.check else 'Imported'} {len(manifest)} Founder Hub migrations")
