# Columbus AI Operating Model

## Goal

Turn Pixel Agents from an office that observes AI coding sessions into the operating surface for a fleet of agents that can execute Columbus AI's business workflows.

The first milestone is not a large number of autonomous agents. It is one Lead coordinating several named Teammates through one complete, visible, auditable workflow.

## Agent Fleet

The Chief of Staff Lead coordinates the business. Named Teammates own durable business functions:

| Function                  | Teammate             |
| ------------------------- | -------------------- |
| Strategy and coordination | Chief of Staff Lead  |
| Marketing                 | Growth Teammate      |
| Sales                     | Sales Teammate       |
| Customer success          | Success Teammate     |
| Product research          | Research Teammate    |
| Engineering               | Engineering Teammate |
| Operations                | Operations Teammate  |
| Finance and reporting     | Finance Teammate     |

Named agents are Teammates because they own an area of responsibility and have durable work. Unnamed delegated work remains a Sub-agent: bounded, temporary work such as research, analysis, drafting, or data cleanup.

## System Responsibilities

Pixel Agents is the visual control plane. It shows which agents exist, what they are doing, what is blocked, and where human attention is needed.

Linear is the execution system and source of truth for work:

- Projects, issues, priorities, owners, dependencies, cycles, and status
- Durable task IDs and links between related work
- Assignment of work to Leads and Teammates
- Retries, escalation, and completion state

Notion is the company brain and source of truth for knowledge:

- Strategy, SOPs, policies, and decisions
- Customer briefs and meeting notes
- Research, proposals, and implementation documentation
- Agent-readable context and institutional memory

Do not mirror everything between Linear and Notion. A work item belongs in Linear; durable knowledge or a decision belongs in Notion.

## Operating Flow

```text
External event
      -> business event bus
      -> task and policy engine
      -> Chief of Staff Lead
      -> named Teammate
      -> Sub-agent work, when needed
      -> tool calls and artifacts
      -> human approval, when required
      -> Linear update and Notion record
```

Agents should communicate through typed tasks, artifacts, events, and decisions rather than relying on unstructured agent-to-agent chat.

## First Workflow

Implement an inbound-lead-to-proposal workflow:

1. A new lead enters the CRM.
2. The Sales Teammate qualifies the lead.
3. The Research Teammate creates a company briefing.
4. The Engineering Teammate estimates the likely solution.
5. The Finance Teammate calculates pricing and margin.
6. The Sales Teammate drafts the proposal.
7. A human approves the proposal.
8. Sales sends it and records the outcome.
9. Success creates the onboarding plan.
10. The Chief of Staff reports pipeline, risks, and next actions.

Each step must have an owner, status, inputs, outputs, timestamps, and a link to the relevant Linear issue or Notion artifact.

## Required Capabilities

### Durable business tasks

Add a business task model with task IDs, owners, dependencies, deadlines, priorities, retry state, escalation state, and links to customers, projects, and revenue.

### Event triggers

Support events from the CRM, email, calendar, Slack, GitHub, billing, analytics, and scheduled objectives. Every event should be normalized before it reaches the runtime.

### Tool adapters

Connect external systems through narrow, typed adapters. Agents should never receive arbitrary API access. Start with read-only access and add writes only for specific actions.

### Persistent memory

Store company knowledge, customer history, decisions, policies, and agent working memory. Important claims should retain source links or citations.

### Approvals and policy gates

Agents may initially research, classify, summarize, draft, and propose automatically. Human approval is required before:

- Sending external messages
- Changing pricing or commercial terms
- Spending money
- Changing production systems
- Signing agreements
- Deleting data

### Observability

The office should eventually show the current objective, business task, blocker, cost, elapsed time, confidence, and whether an agent is waiting for human approval.

## Build Order

1. Add the durable `BusinessTask` model and task queue.
2. Add headless agent registration and execution.
3. Build the inbound-lead-to-proposal workflow.
4. Add Linear integration for task creation and status updates.
5. Add Notion integration for knowledge retrieval and durable artifacts.
6. Add read-only tool permissions and approval gates.
7. Add business task views and outcome metrics to the office.
8. Expand into support, delivery, finance, and marketing.
9. Increase autonomy only after the workflow is observable and recoverable.

## Success Criteria

The first production-quality slice is complete when one Lead can coordinate five Teammates through the full workflow, every action is visible in Pixel Agents, work is tracked in Linear, knowledge is stored in Notion, and human approval is required at the defined boundaries.
