# BMAD Upstream Workflows — Implementation Task

## Overview
Add BMAD upstream workflow capabilities to Claude Code Studio's Kanban board. These workflows run BEFORE the existing sprint implementation pipeline.

## What to Build

### 1. Three BMAD Workflow Types (task creation dropdown)
When creating a task in Kanban, user can select a workflow type:
- **🔍 Analysis** — runs the BMAD Analyst agent to create a product brief
- **📋 Planning** — runs the BMAD Product Manager to create PRD.md  
- **🏗️ Solutioning** — runs the BMAD Architect to create architecture.md, then epics.md

### 2. New Kanban Column: "BMAD Workflow" (or similar)
- Add a new column `bmad_workflow` between Backlog and Todo
- Tasks in this column are running BMAD upstream workflows
- When workflow completes, task moves to Done and outputs are saved to `{workdir}/_bmad-output/`

### 3. Workflow Task Creation
In the "Edit task" / "New task" modal (kanban.html), add a dropdown/selector for workflow type:
- None (default — regular task)
- 🔍 Analysis → Product Brief
- 📋 Planning → PRD  
- 🏗️ Solutioning → Architecture + Epics
- 📐 Sprint Planning → sprint-status.yaml
- ✂️ Shard Document → split large docs

When user saves a task with a workflow type, the task:
1. Gets tagged with `[bmad-workflow:analysis]` (or planning/solutioning/sprint-planning/shard) in notes
2. Gets assigned the right BMAD agent/skill
3. Gets status `bmad_workflow`
4. Starts processing automatically

### 4. Workflow Definitions (in server.js)

```javascript
const BMAD_WORKFLOWS = {
  analysis: {
    label: '🔍 Analysis → Product Brief',
    agent: 'analyst',
    skills: ['bmad-brainstorming', 'bmad-party-mode'],
    model: 'opus',
    outputFile: 'product-brief.md',
    outputDir: '_bmad-output/planning-artifacts',
    prompt: (title, workdir) => `You are the BMAD Analyst. Run the product brief creation workflow for: ${title}\n\nProject directory: ${workdir}\n\nPARTY MODE ACTIVE: Facilitate a multi-agent discussion.\n\nCreate the product brief and save it to ${workdir}/_bmad-output/planning-artifacts/product-brief.md\n\nAfter creating the product brief, output the full document.`
  },
  planning: {
    label: '📋 Planning → PRD',
    agent: 'product-manager',
    skills: ['bmad-create-prd', 'bmad-party-mode'],
    model: 'opus',
    outputFile: 'prd.md',
    outputDir: '_bmad-output/planning-artifacts',
    prompt: (title, workdir) => `You are the BMAD Product Manager. Create the PRD for: ${title}\n\nProject directory: ${workdir}\n\nRead the product brief from ${workdir}/_bmad-output/planning-artifacts/product-brief.md if it exists.\n\nCreate the PRD and save it to ${workdir}/_bmad-output/planning-artifacts/prd.md\n\nAfter creating the PRD, output the full document.`
  },
  solutioning: {
    label: '🏗️ Solutioning → Architecture + Epics',
    agent: 'architect',
    skills: ['bmad-create-architecture', 'bmad-create-epics', 'bmad-party-mode'],
    model: 'opus',
    outputFile: 'architecture.md',
    outputDir: '_bmad-output/planning-artifacts',
    prompt: (title, workdir) => `You are the BMAD Architect. Run the solutioning workflow for: ${title}\n\nProject directory: ${workdir}\n\nRead the PRD from ${workdir}/_bmad-output/planning-artifacts/prd.md if it exists.\n\n1. First create the architecture document and save to ${workdir}/_bmad-output/planning-artifacts/architecture.md\n2. Then create the epics and stories document and save to ${workdir}/_bmad-output/planning-artifacts/epics.md\n\nOutput both documents when complete.`
  },
  'sprint-planning': {
    label: '📐 Sprint Planning → sprint-status.yaml',
    agent: 'scrum-master',
    skills: ['bmad-sprint-planning'],
    model: 'sonnet',
    outputFile: 'sprint-status.yaml',
    outputDir: '_bmad-output/implementation-artifacts',
    prompt: (title, workdir) => `You are the BMAD Scrum Master. Run sprint planning for: ${title}\n\nProject directory: ${workdir}\n\nRead the epics from ${workdir}/_bmad-output/planning-artifacts/epics.md\n\nGenerate sprint-status.yaml and save to ${workdir}/_bmad-output/implementation-artifacts/sprint-status.yaml\n\nFollow the BMAD sprint planning workflow exactly.`
  },
  shard: {
    label: '✂️ Shard Document',
    agent: 'master',
    skills: ['bmad-master'],
    model: 'sonnet',
    outputFile: null,
    outputDir: null,
    prompt: (title, workdir) => `Run the BMAD shard-doc task. The user wants to split this document: ${title}\n\nProject directory: ${workdir}\n\nUse npx @kayvan/markdown-tree-parser to split the document into smaller files.`
  }
};
```

### 5. Task Processing for Workflows
In `startTask()` (around line 545), detect workflow tasks:
- Check for `[bmad-workflow:TYPE]` in task.notes
- Use `BMAD_WORKFLOWS[TYPE]` to get the prompt, model, and skills
- Set the session model to the workflow's model
- Inject the workflow skills into the system prompt

### 6. Kanban UI Changes (kanban.html)

#### a. Add workflow selector to the task creation/edit form
After the "Status" dropdown, add a "Workflow" dropdown:
```html
<label class="lbl">BMAD Workflow</label>
<select id="fWorkflow">
  <option value="">None (regular task)</option>
  <option value="analysis">🔍 Analysis → Product Brief</option>
  <option value="planning">📋 Planning → PRD</option>
  <option value="solutioning">🏗️ Solutioning → Architecture + Epics</option>
  <option value="sprint-planning">📐 Sprint Planning → sprint-status.yaml</option>
  <option value="shard">✂️ Shard Document</option>
</select>
```

#### b. When saving a task with a workflow:
- Tag notes with `[bmad-workflow:TYPE]`
- Set status to `bmad_workflow` 
- The task worker picks it up automatically

#### c. Add the `bmad_workflow` column to COLS array
Insert after Backlog, before Todo:
```javascript
{ id: 'bmad_workflow', label: '🔮 BMAD Workflow', color: '#9333ea' }
```

#### d. Treat `bmad_workflow` as an active status in `isTaskActive()`

### 7. Workflow Output Display
When a workflow task completes:
- The output files are saved in `{workdir}/_bmad-output/`
- The task moves to `done`
- Send notification via openclaw-notify

### 8. Shard Document Integration
The shard task splits large markdown files using `npx @kayvan/markdown-tree-parser explode [source] [destination]`
- This is useful after solutioning creates large `architecture.md` or `epics.md` files
- The user can then shard them for better agent context management

## Files to Modify

1. **server.js**:
   - Add `BMAD_WORKFLOWS` config object near line 46 (next to `BMAD_PHASE_MODEL_MAP`)
   - Update `startTask()` to detect and handle workflow tasks
   - Add `bmad_workflow` to active status checks
   - Ensure workflow tasks get proper skills injected

2. **kanban.html**:
   - Add `bmad_workflow` column to `COLS` array
   - Add workflow dropdown to task edit/create modal
   - Handle workflow selection in save logic
   - Add `bmad_workflow` to `isTaskActive()` check
   - Show workflow type badge on cards

## Reference Files
- BMAD agents: `/home/ubuntu/.openclaw/workspace/bmad-openclaw/agents/`
- BMAD templates: `/home/ubuntu/.openclaw/workspace/bmad-openclaw/templates/`
- BMAD workflows: `/tmp/BMAD-METHOD/src/bmm/workflows/`
- Sprint planning workflow: `/tmp/BMAD-METHOD/src/bmm/workflows/4-implementation/sprint-planning/workflow.md`
- Shard task: `/tmp/BMAD-METHOD/src/core/tasks/shard-doc.xml`
- Existing skills: `/home/ubuntu/claude-code-studio/skills/bmad-*.md`

## Testing
After implementation:
1. Create a new task with "Analysis" workflow → should start processing and generate product-brief.md
2. Verify the BMAD Workflow column shows the task
3. Verify notification fires on completion
4. Check that the output file exists in `_bmad-output/planning-artifacts/`

## IMPORTANT
- Do NOT break existing functionality
- The existing BMAD phase columns (Brainstorm, PRD, Architecture, Implementation, QA) are for sprint IMPLEMENTATION tasks
- The new bmad_workflow column is for upstream PLANNING tasks
- Keep all existing auto-dispatch chain logic intact
