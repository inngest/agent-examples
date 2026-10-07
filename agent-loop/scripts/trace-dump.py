#!/usr/bin/env python3
# Dump goal-loop / agent-attempt runs from the local Inngest dev server
# (GraphQL on :8288): per-attempt score, cost, turn-by-turn token usage and
# tool calls. Used to fill BUILD_LOG.md.
#
#   python3 scripts/trace-dump.py <since ISO time> [run_id ...]
#   python3 scripts/trace-dump.py 2026-10-07T01:47:00Z
#
# Dev server only. The REST /v1/events/{id}/runs status can be wrong for
# in-flight runs; this uses GraphQL runTrace instead.
import json
import sys
import urllib.request

GQL = 'http://localhost:8288/v0/gql'


def gq(q):
    r = urllib.request.Request(GQL, data=json.dumps({"query": q}).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r))['data']


def out(oid):
    """A span's output, unwrapped from its {"data": ...} envelope when it is JSON."""
    d = gq('{ runTraceSpanOutputByID(outputID: "%s") { data } }' % oid)['runTraceSpanOutputByID']['data']
    try:
        j = json.loads(d)
        return j.get('data', j) if isinstance(j, dict) else j
    except:
        return d


since = sys.argv[1]
only = sys.argv[2:]  # optional run ids
runs = gq('{ runs(first: 100, filter:{from:"%s"}, orderBy:[{field:QUEUED_AT,direction:ASC}]) { edges { node { id status function { slug } } } } }' % since)['runs']['edges']
for e in runs:
    rid, slug, st = e['node']['id'], e['node']['function']['slug'], e['node']['status']
    if only and rid not in only:
        continue
    spans = gq('{ runTrace(runID: "%s") { childrenSpans { name status startedAt endedAt outputID } } }' % rid)['runTrace']['childrenSpans']
    print('=====', slug, rid, st)
    # Last span per step name (a retried step appears more than once).
    seen = {}
    for s in spans:
        seen[s['name']] = s
    for name, s in seen.items():
        o = out(s['outputID']) if s['status'] == 'COMPLETED' and s['outputID'] else None
        t = f"{s['startedAt'][11:19]}-{(s['endedAt'] or '')[11:19]}"
        if name.startswith('turn') and isinstance(o, dict) and 'choices' in o:
            u = o.get('usage', {})
            m = o['choices'][0]['message']
            print(f"{name} {t} c={u.get('completion_tokens')} r={(u.get('completion_tokens_details') or {}).get('reasoning_tokens')} ${u.get('cost',0):.4f} fin={o['choices'][0].get('finish_reason')} calls={[c['function']['name'] for c in m.get('tool_calls') or []]}")
        elif name.startswith('tool'):
            print(f"{name}: {str((o or {}).get('result',o))[:200]!r}")
        elif name.startswith(('check', 'baseline', 'rebaseline', 'holdout')):
            if isinstance(o, dict):
                print(name, t, {k: o.get(k) for k in ('failed', 'total', 'score', 'checkVersion', 'commit')})
                print('   ' + o.get('report', '')[:700].replace('\n', '\n   '))
        elif name.startswith('attempt') and isinstance(o, dict):
            print(name, t, {k: o.get(k) for k in ('commit', 'changed', 'finished', 'costUsd', 'turns', 'tokens', 'summary')})
        elif name.startswith(('turn', 'prepare', 'commit', 'score', 'scored')):
            pass  # not worth printing
        else:
            print(name, s['status'], t, str(o)[:150])
