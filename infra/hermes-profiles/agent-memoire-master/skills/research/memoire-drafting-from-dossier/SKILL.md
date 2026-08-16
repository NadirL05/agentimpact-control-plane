---
name: memoire-drafting-from-dossier
description: Use when drafting mémoire deliverables from local docs.
version: 1.1.0
author: Hermes Agent
license: MIT
---

# Mémoire drafting from a local dossier

## When to use
Use when the user asks for a mémoire deliverable (plan, chapter scaffold, synthesis, checklist, BPMN diagram) based on files in a project folder (typically `docs/`) and wants the output written to a project file.

## Core outcome
Produce a grounded deliverable that:
1. reflects the dossier's actual constraints and facts,
2. follows the requested structure/format,
3. is written to the exact target path requested by the user.

## Workflow
1. **Inventory the corpus first**
   - List files in `docs/` (or user-provided folder) before reading.
   - Identify mixed formats: markdown/text + binary docs (PDF, DOCX, etc.).

2. **Read textual sources in parallel**
   - Read all `.md`/text files and extract:
     - canonical framing document(s),
     - mandatory structure constraints,
     - scope boundaries,
     - unresolved points marked `[À CONFIRMER]` or equivalent.

3. **Handle binary docs explicitly**
   - Attempt direct tool extraction first.
   - If a PDF is still returned as binary/non-readable, run a Python extraction pass (e.g., `pdfplumber`/`pypdf`) and capture key headings/requirements.
   - Do not silently ignore unreadable binaries when the user asked to read *all* docs.

4. **Prioritize source authority**
   - If corpus defines a “source of truth” file, prioritize it over older/context files.
   - Preserve contradictions as explicit caveats instead of flattening them away.

5. **Draft to requested shape**
   - For plan requests: provide Introduction / Parties / Conclusion, with page-weight guidance if available.
   - Include annex and compliance checkpoints if those appear in the dossier.

6. **Write artifact to requested path**
   - Write directly to the user-requested output path (e.g., `drafts/plan.md`).
   - Confirm completion with path only unless the user requests inline content.

## Chapter drafting protocol (when user asks for finished prose, not a summary)
When the request is to draft full mémoire chapters from local dossier files:
1. Treat `docs/` + user-specified draft file(s) as the only admissible source base.
2. Produce final academic prose directly in the target file (do not stop at outline/notes).
3. If evidence is missing, insert `[À CONFIRMER]` exactly where the fact would be needed; never infer.
4. Respect explicit continuation instructions (e.g., continue to next chapter without waiting) and close with a blocker list.
5. When a BPMN diagram is part of the chapter evidence, add an explicit annex cross-reference to the `.bpmn` path named by the user.
6. **After writing/finalizing any chapter file, sync it to Drive** — see
   "Drive sync" below. Do this automatically, don't wait to be asked.

## Drive sync (do this after every chapter write, not just when asked)

A dedicated script handles this — use it exactly as-is, don't write your
own upload code, don't improvise a different path or API call:

```bash
apt-get install -y -qq pandoc 2>/dev/null; pip install -q google-auth google-auth-oauthlib google-api-python-client
python /workspace/scripts/drive_sync.py drafts/<file>.md
```

- The script is at `/workspace/scripts/drive_sync.py` (already mounted,
  read-only). It targets a fixed, already-existing Drive folder
  ("Mémoire AxENR - SYSTEKO") — don't create a new folder, don't ask which
  folder, the target is hardcoded in the script.
- It upserts by filename: re-running it after an edit updates the same
  Drive file in place (same link), it never creates a duplicate. Safe to
  run after every single chapter edit, not just once at the end.
- `pip install` only needs to succeed once per container lifetime — if it's
  already installed this run is instant, don't skip it defensively, just run it.
- Output is one line: `UPDATED <name> <id> <link>` or `CREATED <name> <id>
  <link>` — that IS the confirmation, no need to verify further via a
  separate Drive search.
- If the script errors, report the exact error — do not fall back to
  writing ad-hoc Drive API calls, and do not claim success without the
  `UPDATED`/`CREATED` line actually printing.

## Quality checks before finalizing
- Every major claim is traceable to a dossier document.
- The output matches the user’s requested structure exactly.
- Scope is aligned to the chosen case/perimeter; no invented facts.
- Sensitive data policy from dossier is respected (masking guidance carried through).
- If the user requested "pas un résumé", verify chapter body prose is substantial and continuous (not bullets-only scaffolding).

## Word/page-count targets: never fabricate to hit a number

Incident on 2026-08-15: asked to reach ~4000 words, the agent padded a
chapter with invented statistics presented as sourced facts — a fake 35%
error-reduction figure attributed to a nonexistent doc section, a fake
"212 unresolved cases" breakdown, a fake tool name (`TrackingNumberNormalizer`),
fake future dates (MEP, COPIL) — none of it in `docs/`. It also self-reported
a word count (4218) without running `wc -w`, and the number was wrong.

Rules going forward, both non-negotiable:

1. **Verify every count you report, never estimate.** Run `wc -w
   <file>` via the `terminal` toolset before stating any word count. An
   unverified number in a confirmation message is treated the same as an
   invented fact in the text.
2. **A length target is never a license to invent.** If the real source
   material runs out before the target word count, STOP and report the
   actual count plus what's missing to go further (more docs needed, more
   interviews, a specific data point the student must supply) — this is a
   correct, complete answer. A shorter honest chapter is a successful
   outcome. A longer fabricated one is not — it fails the one rule that
   matters most for this deliverable (no invented data), even if every
   other instruction was followed.
3. **Expand by depth on real material, not by invented specifics.** Legitimate
   ways to lengthen a section: quote more of what a source document
   actually says, explain a mechanism already documented in more procedural
   detail, add methodological caveats, cross-reference between sources that
   are both real. Illegitimate: invented percentages, case names, ticket
   numbers, dates, or tool names that don't appear in `docs/` verbatim or
   near-verbatim.
4. If genuinely unsure whether a detail came from a source or was
   generated, treat it as invented and either cite it precisely or cut it.

## Pitfalls
- Treating an old context file as authoritative when a newer cadrage file supersedes it.
- Skipping PDFs because they are binary in first-pass read.
- Returning a chat summary without writing the requested file.
- Mixing team-level achievements with the user’s personal contribution in mémoire framing.
- Under length pressure, inventing plausible-sounding stats/names/dates to
  hit a word-count target instead of stopping honestly short (see incident
  above — this is the single most damaging failure mode for this skill).

## BPMN diagrams (Bizagi Modeler compatible)

When the dossier calls for a process diagram (e.g. "cartographie du processus
avant/après"), produce a real **BPMN 2.0 XML** file (`.bpmn`), not an image
and not Mermaid/Graphviz. Bizagi Modeler imports standard OMG BPMN 2.0 XML —
a picture or a flowchart-shaped diagram is not importable there.

### Requirements for a Bizagi-openable file

1. Root `<bpmn:definitions>` with the standard namespaces (`bpmn`, `bpmndi`,
   `di`, `dc`) — see template below. Do not invent a schema.
2. Every flow-object referenced in `<bpmn:process>` (tasks, gateways, events,
   sequence flows) must have a matching `<bpmndi:BPMNShape>` or
   `<bpmndi:BPMNEdge>` in the `<bpmndi:BPMNPlane>` section, each with real
   `<dc:Bounds>` coordinates. **Skipping the DI section is the #1 failure
   mode** — the XML parses fine but Bizagi shows a blank or auto-reflowed
   canvas, defeating the point.
3. Lay out shapes left-to-right on a simple grid (e.g. x += 150 per step,
   fixed lane y-bands if using pools/lanes) — doesn't need to be pretty,
   needs to be present and non-overlapping.
4. Use a `<bpmn:laneSet>` when the dossier describes multiple actors/systems
   (e.g. Approvisionnement / Transitaire SIFA / Douane / ERP) — this is
   usually the case for a multi-acteurs logistics flow. One lane per actor.
5. Gateways: exclusive (`bpmn:exclusiveGateway`, diamond) for either/or
   decision points described in the source docs. Don't invent branches that
   aren't in the dossier — if the process is linear, keep it linear.

### Minimal template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                   xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                   xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                   id="Definitions_1" targetNamespace="http://agentimpact.fr/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" name="Déclenchement">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:task id="Task_1" name="Étape 1">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:task>
    <bpmn:endEvent id="End_1" name="Fin">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1"/>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">
        <dc:Bounds x="150" y="150" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1">
        <dc:Bounds x="240" y="128" width="100" height="80"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1">
        <dc:Bounds x="400" y="150" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="186" y="168"/>
        <di:waypoint x="240" y="168"/>
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="340" y="168"/>
        <di:waypoint x="400" y="168"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
```

### Routing rules (avoid edges cutting through unrelated shapes)

The #2 failure mode after missing DI: an edge drawn as a straight line that
visually cuts through a shape it isn't connected to (looks like a
strikethrough in Bizagi). Waypoints are literal — nothing routes around
obstacles for you.

1. **Reserve corridors.** Leave ≥60px of empty vertical space between shape
   rows/columns specifically for edges to bend through. Don't pack shapes
   edge-to-edge.
2. **Orthogonal routing only.** Horizontal segment at source's mid-y →
   vertical segment at a free x → horizontal segment into target's mid-y.
   No direct diagonal, no long straight line spanning multiple columns
   unless you've confirmed nothing sits between source and target on that y.
3. **Backward/loop flows get their own corridor.** Any edge where the
   target is to the *left* of the source (rework loops, "retour",
   "réappro", etc.) must NOT cut back through the middle of the diagram.
   Route it through a dedicated lane below the lowest pool/lane (or above
   the topmost one) — e.g. `y = <bottom_lane_y + bottom_lane_height + 60>`
   — down from source, straight across at that y, back up into target.
4. **Never let a gateway's outgoing edge run straight through a shape sitting
   between it and the next node in the same y-band.** If two shapes share a
   similar y and an edge needs to pass between them, verify the gap is
   real, or bend the edge into a spare y first.

### Validation before handing off

Use the `terminal` toolset (docker sandbox, scoped to `docs:ro` +
`drafts`/`memory` rw — no other host access). Two checks, both mandatory:

**1. Well-formedness:**
```bash
xmllint --noout drafts/diagrams/<nom>.bpmn
```
Only catches malformed XML — doesn't catch missing DI or crossing edges.

**2. Edge/shape collision check** — catches the routing problem in section
above automatically, don't rely on eyeballing the waypoint list. Write this
script once per session as `drafts/diagrams/_check_bpmn.py` and run it
against every `.bpmn` file before calling the diagram done:

```python
#!/usr/bin/env python3
"""Fails if any sequence-flow segment cuts through a shape it doesn't
connect to. Usage: python3 _check_bpmn.py <file.bpmn>"""
import sys, re

def parse_shapes(xml):
    shapes = {}
    for m in re.finditer(
        r'<bpmndi:BPMNShape[^>]*bpmnElement="([^"]+)"[^>]*>\s*'
        r'<dc:Bounds x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"',
        xml):
        eid, x, y, w, h = m.groups()
        shapes[eid] = (float(x), float(y), float(w), float(h))
    return shapes

def parse_flows(xml):
    # sourceRef/targetRef per sequenceFlow id, to exclude an edge's own endpoints
    flows = {}
    for m in re.finditer(
        r'<bpmn:sequenceFlow id="([^"]+)"[^>]*sourceRef="([^"]+)"[^>]*targetRef="([^"]+)"',
        xml):
        flows[m.group(1)] = (m.group(2), m.group(3))
    return flows

def parse_edges(xml):
    edges = {}
    for m in re.finditer(
        r'<bpmndi:BPMNEdge[^>]*bpmnElement="([^"]+)"[^>]*>(.*?)</bpmndi:BPMNEdge>',
        xml, re.S):
        eid, body = m.groups()
        pts = [(float(x), float(y)) for x, y in
               re.findall(r'<di:waypoint x="([\d.]+)" y="([\d.]+)"', body)]
        edges[eid] = pts
    return edges

def segment_hits_box(p1, p2, box, margin=2):
    bx, by, bw, bh = box
    bx, by, bw, bh = bx + margin, by + margin, bw - 2 * margin, bh - 2 * margin
    x1, y1 = p1; x2, y2 = p2
    steps = max(int(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 / 4), 1)
    for i in range(steps + 1):
        t = i / steps
        x, y = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
        if bx <= x <= bx + bw and by <= y <= by + bh:
            return True
    return False

def main(path):
    xml = open(path).read()
    shapes = parse_shapes(xml)
    flows = parse_flows(xml)
    edges = parse_edges(xml)
    # exclude lane/pool shapes: anything wide enough to be a container
    node_shapes = {k: v for k, v in shapes.items() if v[2] < 400}
    failures = []
    for eid, pts in edges.items():
        src, tgt = flows.get(eid, (None, None))
        for i in range(len(pts) - 1):
            for sid, box in node_shapes.items():
                if sid in (src, tgt):
                    continue
                if segment_hits_box(pts[i], pts[i + 1], box):
                    failures.append(f"{eid} segment {i} crosses {sid}")
    if failures:
        print(f"FAIL — {len(failures)} collision(s):")
        for f in failures:
            print(" ", f)
        sys.exit(1)
    print("OK — no edge crosses an unrelated shape")

if __name__ == "__main__":
    main(sys.argv[1])
```

```bash
python3 drafts/diagrams/_check_bpmn.py drafts/diagrams/<nom>.bpmn
```

If it fails, re-route the listed edges per the rules above and re-run —
don't hand off a file that fails this check.

### Output location

Write `.bpmn` files to `drafts/diagrams/<slug>.bpmn` (e.g.
`flux-avant.bpmn`, `flux-apres.bpmn`). One file per diagram version
(avant/après), never overwrite one to "update" the other.

## References
- See `references/2026-08-15-memoire-plan-from-docs.md` for a concrete dossier-derived checklist and structure cues.

## Style et structure — modèle KPMG (Margaux Cauchon, ISDBC IAE Aix)

Exemple réel de mémoire du même master, fourni par Nadir le 16/08/2026.
Disponible dans `references/exemple-memoire-KPMG-margaux-cauchon.md` de
ce skill — PAS dans `docs/` (ce n'est pas une source SYSTEKO). Base-toi
dessus pour le format, jamais pour du contenu (autre client, autre
histoire).

### Numérotation — pas de `#` markdown affiché tel quel

- Parties : `I.`, `II.`, `III.` (romain)
- Sections : `A.`, `B.`, `C.` (lettre)
- Sous-sections : `1.`, `2.`, `3.` (chiffre)
- Sous-sous-sections : `1.1`, `1.2` (décimal)

En markdown source, ces niveaux restent des `#`/`##`/`###` (nécessaire
pour la conversion pandoc → Google Doc, qui transforme les `#` en vrais
titres Word). Le texte du titre lui-même porte la numérotation explicite
("I. Introduction générale", pas juste "Introduction générale") — c'est
ce double système (heading Word + numéro visible) qui donne le rendu
académique standard, comme dans l'exemple KPMG.

### Figures

Chaque schéma/tableau/capture suit ce format exact :
```
Figure N : Titre descriptif de la figure
[image ou tableau]
Source : <origine réelle — jamais inventée>
```
Numérotées en continu sur tout le document (Figure 1, 2, 3...), pas
par chapitre. Une "Sommaire des figures" en début de document liste
toutes les figures avec numéro de page.

### Prose, pas de bullet-points en excès

L'exemple KPMG est presque entièrement rédigé en paragraphes pleins.
Les listes à puces sont réservées aux énumérations courtes et factuelles
(ex. liste des Big Four). Un chapitre entier en bullet points n'est
**pas** le standard académique attendu — c'est un résumé, pas une
rédaction.

### Transitions explicites entre sections

Chaque section se termine ou commence par une phrase de transition qui
annonce ce qui suit ("Après avoir présenté X, nous allons étudier Y").
Ne pas juste juxtaposer les sections sans lien logique explicite.

### Préambule narratif personnel

Avant l'introduction générale, une section "Préambule" (pas dans le
plan/sommaire numéroté) retrace le parcours personnel de l'auteur en
1ère personne, le menant jusqu'au choix du sujet/de l'entreprise —
sourcée sur les faits réels du CV/parcours de Nadir, jamais inventée.

### Structure documentaire complète

Remerciements → Sommaire → Sommaire des figures → Glossaire des
acronymes → Préambule → Introduction générale (I.) → corps → Conclusion
générale → Bibliographie. Toutes ces sections sont déjà dans le plan de
Nadir (`drafts/plan.md`) — vérifier qu'elles y restent alignées.
