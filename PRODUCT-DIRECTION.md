# AI Team Assistant: Proposed Direction

Status: product exploration, not implemented functionality.

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

There is no AI integration, collaboration UI, identity system, multi-project
authorization, or paid service yet. Database least-privilege separation is also
pending; the local baseline audit documents excessive application privileges.

The existing runtime must not be exposed publicly as a finished team product.
Market demand, pricing, and customer willingness to pay remain unvalidated.
