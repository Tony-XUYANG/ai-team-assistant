# AI Team Assistant: Proposed Direction

Status: product exploration with a local workbench and project-context API in 3.7.0.
The proposed AI/team workflow below remains a direction, not a completed product.

## Audience and purpose

Help individuals and small teams coordinate work across multiple projects.
The audience includes developers, operations staff, and non-technical knowledge
workers. A single person should benefit without first setting up a team.

The central workflow is resuming or handing off work: understand the objective,
current verified state, outstanding decisions, owners, and next actions without
reconstructing context from scattered conversations and resources.

## Proposed first workflow

1. Create a project with its objective, constraints, resources, and participants.
2. Record progress, decisions, blockers, and next actions with sources and dates.
3. Review an AI-assisted summary that separates facts, proposals, and unknowns.
4. Hand off a bounded task to a person or AI with explicit acceptance criteria.
5. Record the outcome and verification evidence before marking work complete.

Start with explicit inputs and a small number of authorized integrations.
Do not attempt to replace chat, document editors, code tools, and task managers
all at once. Validate the workflow with real individual and team users first.

## Trust requirements for future implementation

- Isolate projects, accounts, and connected data by authorization boundaries.
- Keep source references and freshness visible; do not invent a healthy status.
- Do not include credentials or unrelated project information in AI context.
- Treat connected documents and messages as data, not executable instructions.
- Require explicit authorization for high-impact actions such as deployments,
  permission changes, external messages, and deletion.
- Support export, audit history, and user-controlled disconnection of integrations.

## Current foundation and gaps

The repository implements link creation, redirects, optional titles, PostgreSQL
persistence, containerization, Kubernetes lab manifests, tests, and local
release/backup/recovery exercises. Links can become a resource-entry feature.

The 3.4.0 API adds project objectives and constraints, progress/decision/blocker/
action records with required sources, explicit verification states, immutable
revisions, and a deterministic handoff brief. Missing confirmation stays
unverified. Corrections retain history and superseded entries leave the brief.
Project references are scoped and enforced with a composite foreign key.
The 3.5.0 workbench adds a Chinese browser interface: project navigation,
briefs, history, project details, record creation, task completion, blocker
resolution, and JSON export. The 3.6.0 handoff action copies the current brief
as Markdown with sources, timestamps, verification labels, truncation state, and
explicit trust boundaries. It leaves transmission to the person using the
workbench. The 3.7.0 overview compares loaded projects by actions, blockers,
and unverified records before opening a single-project brief. See
[PROJECT-WORKSPACE.md](PROJECT-WORKSPACE.md) and
[WORKSPACE-UI.md](WORKSPACE-UI.md). The local Kubernetes service still runs the
previously accepted 3.3.0 release until a separate rollout.

There is no AI integration, identity system, multi-project authorization, or paid
service yet. The workbench is a local single-user preview, not a team product.
Database least-privilege separation is also pending; the local baseline audit
documents excessive application privileges.

The existing runtime must not be exposed publicly as a finished team product.
Market demand, pricing, and customer willingness to pay remain unvalidated.

Next validation: let one person resume work across multiple real projects using
the workbench, then test bounded handoffs with a small team. Add authenticated
ownership and authorization before connecting real team data or an AI provider.
Do not interpret an owner_ref label or project UUID as an identity.
