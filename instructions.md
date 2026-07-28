AI-Native Development Coordinator

Product Context and Build Instructions

1. Purpose

This document defines the product vision, architecture, implementation principles, and build sequence for an AI-native software development coordination platform.

The product is not another coding agent.

It is a coordination layer that sits between:

Software developers

Coding agents

Shared development environments

Source control

Build and test systems

Security and policy controls

The platform should allow developers to keep using their preferred coding agents while coordinating all work against a shared canonical codebase.

The core objective is:

Coordinate work before and while it happens so that conflicts, duplicated effort, stale assumptions, and integration failures are prevented rather than repaired later.

2. Intended Deployment Model

This is primarily a multi-developer and multi-device platform.

Multiple developers and multiple coding agents may connect from:

Different computers

Different locations

A shared local network

A managed cloud environment

A customer-hosted environment

An on-premises enterprise deployment

A single-user local mode may exist later, but the main product is a cross-device coordination system. Design decisions should assume more than one developer and more than one machine unless there is a specific reason not to.

3. Main Product Difference

Most current agent orchestration tools solve this problem:

How can several agents help one developer?

This product solves a different problem:

How can several developers and several agents safely modify one evolving software system at the same time?

This product should coordinate:

Files

Symbols

Interfaces

Dependencies

Database schemas

Build targets

Tests

Agent intentions

Integration order

Canonical code state

It should not limit itself to coordinating:

Tasks

Tickets

Branches

Pull requests

Commits

Existing products often coordinate tasks around the codebase. This product coordinates the evolution of the codebase itself.

4. Product Vision

Traditional software development usually follows this model:

Developer
    ↓
Local clone
    ↓
Branch
    ↓
Commit
    ↓
Push
    ↓
Pull request
    ↓
Merge

The proposed platform should move toward this model:

Developer or coding agent
            ↓
      Central coordinator
            ↓
   Isolated task workspace
            ↓
 Validation and policy gates
            ↓
   Shared canonical codebase
            ↓
 Git history, rollback, export

From the user's perspective, the system should feel like a live shared codebase.

Internally, each task should still execute in an isolated workspace so unfinished or unsafe changes do not directly modify the canonical codebase.

5. Core Product Principle

The coordinator is an AI traffic controller, not an AI project manager.

It should not primarily decide what the company should build.

It should coordinate how approved engineering work is safely executed.

The coordinator should:

Receive task intent

Receive agent plans

Predict affected files, symbols, APIs, schemas, and dependencies

Allocate temporary ownership

Decide what can run in parallel

Sequence dependent work

Detect likely conflicts

Notify agents when the canonical state changes

Validate proposed changes

Integrate accepted work atomically

Preserve rollback and audit history

The central design principle is:

Most products coordinate tasks. This product coordinates the codebase itself.

6. Non-Goals

The initial product should not attempt to:

Build a new foundation model

Replace every IDE

Eliminate Git internally

Allow unrestricted concurrent writes to one filesystem

Fully resolve all semantic conflicts automatically

Support every programming language immediately

Replace GitHub on day one

Build enterprise compliance before proving product value

Create a completely autonomous software company

Git should remain available underneath the platform for:

History

Rollback

Releases

Audit

Disaster recovery

Export

External compatibility

These are read and export paths. Writing to canonical through Git directly
— branching, merging, or resetting outside the coordinator's pipeline — is
intentionally unsupported in every phase, not just the first. History,
rollback, and review features are built on Git history but always go
through the coordinator (see section 18).

7. Primary Users

Initial users

Small engineering teams using multiple coding agents

AI-native startups

Developers using Claude Code, Codex, Cursor, Gemini, or similar tools

Teams experiencing duplicated agent work or repeated merge conflicts

Later users

Large software organizations

Enterprise engineering departments

Regulated companies

Government contractors

Security-sensitive organizations

Companies requiring private-cloud, hybrid, on-premises, or air-gapped deployment

8. Core User Experience

A typical workflow should be:

A developer submits a task.

The developer selects a coding agent.

The agent submits a proposed plan before editing.

The coordinator analyzes the plan.

The coordinator grants resource ownership or imposes constraints.

The task runs in an isolated workspace.

The agent reports progress and scope changes.

The coordinator monitors dependencies and conflicts.

The agent submits a changeset.

The platform applies the changeset to a temporary integration snapshot.

Tests, builds, policy checks, and security checks run.

The validated snapshot becomes canonical atomically.

Git history is updated.

Dependent tasks receive the new canonical state.

9. Shared Codebase Model

Do not allow all agents to directly edit the same writable filesystem.

Instead, use:

A canonical read-only repository state

One isolated copy-on-write overlay per task

Transactional changesets

Atomic promotion of validated changes

Real-time projection of accepted changes to users

Recommended model:

Canonical repository version
        ├── Human workspace projection
        ├── Agent task overlay A
        ├── Agent task overlay B
        └── Integration snapshot

Each agent should see:

The latest approved canonical state

Its own uncommitted modifications

Coordinator messages

Relevant changes from dependent tasks

Agents should not see another agent's incomplete work as canonical.

10. Main System Components

The platform should contain the following major services.

8.1 Client Applications

Web IDE

Desktop extension

CLI

Admin console

Approval dashboard

Monitoring interface

8.2 API Gateway

Responsibilities:

Authentication

Authorization

Rate limiting

Request routing

Session management

WebSocket handling

API versioning

8.3 Coordinator Engine

Responsibilities:

Plan analysis

Task scheduling

Ownership allocation

Conflict prediction

Dependency management

Sequencing

Replanning

Escalation

Integration ordering

8.4 Workspace Manager

Responsibilities:

Create isolated task environments

Mount repository snapshots

Manage terminals

Start and stop containers

Enforce CPU, memory, disk, and timeout limits

Stream workspace events

Snapshot and restore task environments

8.5 Agent Gateway

Responsibilities:

Normalize agent capabilities

Start agent sessions

Send coordinator context

Pause, resume, and cancel agents

Receive plans and scope changes

Collect structured changesets

Track token usage and cost

8.6 Repository Service

Responsibilities:

Import repositories

Maintain Git mirrors

Track canonical versions

Create commits

Export repositories

Manage tags and releases

Synchronize external changes

8.7 Code Intelligence Service

Responsibilities:

Parse code

Index symbols

Build dependency graphs

Track API usage

Track schema usage

Track build targets

Identify affected tests

Detect structural change impact

8.8 Integration Service

Responsibilities:

Rebase or replay changes

Apply changes to temporary snapshots

Compile code

Run tests

Run linters

Run security scans

Run policy checks

Promote successful snapshots

Roll back failures

8.9 Policy Engine

Responsibilities:

File and directory permissions

Network access policies

Model access policies

Approval requirements

Secret access

Restricted operations

Risk-based controls

8.10 Audit Service

Responsibilities:

Record human actions

Record agent actions

Record commands

Record ownership grants

Record approvals

Record integrations

Record policy violations

Preserve tamper-evident history

11. Recommended Technology Stack

Frontend

React

Next.js

TypeScript

Monaco Editor

xterm.js

WebSockets

TanStack Query

Zustand or Redux Toolkit

Backend

For the first version:

TypeScript

Node.js

PostgreSQL

Redis

Docker

For later infrastructure-heavy services:

Go

Kubernetes

NATS JetStream or Kafka

Object storage

OpenTelemetry

Python may be used for:

Model evaluation

Semantic conflict experiments

Code intelligence research

Offline analytics

Do not make Python the default language for latency-sensitive orchestration services unless the team has a strong reason.

12. Agent-Neutral Design

The platform must support multiple coding agents through adapters:

Claude Code

Codex

Cursor

Gemini

Open-source agents

Internal or proprietary agents

Generic command-line agents

The core coordinator must not depend on provider-specific features.

The coordinator defines the minimum common protocol every agent must satisfy. Advanced provider capabilities remain optional and must never become a requirement of the coordination path.

13. Agent Coordination Protocol

All supported coding agents should communicate through a normalized protocol.

Agent capabilities

interface AgentCapabilities {
  canPlan: boolean;
  canEditFiles: boolean;
  canRunCommands: boolean;
  canUseTools: boolean;
  supportsStreaming: boolean;
  supportsPause: boolean;
  maximumContextTokens?: number;
}

Required adapter interface

interface AgentAdapter {
  getCapabilities(): Promise<AgentCapabilities>;

  startTask(input: StartTaskInput): Promise<AgentSession>;

  requestPlan(sessionId: string): Promise<AgentPlan>;

  sendContext(
    sessionId: string,
    context: CoordinatorContext
  ): Promise<void>;

  pause(sessionId: string): Promise<void>;

  resume(sessionId: string): Promise<void>;

  cancel(sessionId: string): Promise<void>;

  collectChanges(sessionId: string): Promise<ChangeSet>;

  streamEvents(
    sessionId: string,
    handler: (event: AgentEvent) => void
  ): Promise<void>;
}

Example task proposal

{
  "task_id": "task_123",
  "objective": "Add password reset functionality",
  "expected_files": [
    "src/auth/reset.ts",
    "src/routes/auth.ts"
  ],
  "expected_symbols": [
    "requestPasswordReset",
    "resetPassword"
  ],
  "dependencies": [
    "EmailService",
    "UserRepository"
  ],
  "commands": [
    "npm test",
    "npm run lint"
  ],
  "external_access": [
    "api.sendgrid.com"
  ],
  "risk_level": "medium"
}

Example coordinator response

{
  "decision": "approved_with_constraints",
  "task_id": "task_123",
  "workspace_id": "workspace_721",
  "ownership_grants": [
    {
      "resource": "symbol:requestPasswordReset",
      "mode": "exclusive"
    },
    {
      "resource": "file:src/routes/auth.ts",
      "mode": "shared"
    }
  ],
  "constraints": [
    "Do not modify the UserRepository interface",
    "Use the existing EmailService API"
  ],
  "blocked_by": []
}

Scope-change event

Agents must report when actual work expands beyond the approved plan.

{
  "event": "scope_change_requested",
  "additional_files": [
    "src/services/email.ts"
  ],
  "reason": "The existing service lacks a reset template method"
}

The coordinator may:

Approve the request

Reject the request

Add constraints

Pause another task

Sequence the task

Split the task

Escalate to a human

14. Ownership Model

Do not rely only on hard file locks.

Use multiple ownership modes.

type OwnershipMode =
  | "observe"
  | "shared"
  | "intent"
  | "exclusive"
  | "approval_required";

Recommended behavior:

Documentation files may use shared ownership.

Independent symbols may use exclusive ownership.

Public APIs may use intent ownership.

Package manifests may use short exclusive leases.

Database migrations should require approval.

Security-sensitive files should require human approval.

Ownership should expire automatically.

interface ResourceLease {
  leaseId: string;
  resourceType: "file" | "symbol" | "api" | "schema" | "service";
  resourceId: string;
  principalId: string;
  taskId: string;
  mode: OwnershipMode;
  baseVersion: number;
  expiresAt: Date;
}

15. Conflict Detection Levels

Level 1: File-level conflicts

Detect when multiple tasks plan to edit the same file.

This should be implemented first.

Level 2: Symbol-level conflicts

Detect changes to:

Functions

Classes

Types

Interfaces

Routes

Configuration keys

Database schemas

Level 3: Dependency-level conflicts

Detect when one task changes something another task consumes.

Example:

Task A changes createUser() parameters.
Task B adds a new caller of createUser().

The tasks may edit different files but remain coupled.

Level 4: Intent-level conflicts

Detect logically incompatible goals.

Example:

Task A removes password authentication.
Task B adds password reset support.

Intent-level analysis should initially be advisory.

Do not allow an LLM to silently block major work without transparent evidence and override controls.

16. Conflict Scoring

Begin with a deterministic score.

Conflict score =
  file overlap
+ symbol overlap
+ dependency impact
+ schema impact
+ configuration overlap
+ test overlap
+ semantic conflict probability

Example implementation:

const conflictScore =
  fileOverlap * 20 +
  symbolOverlap * 35 +
  dependencyImpact * 25 +
  schemaImpact * 40 +
  configOverlap * 15 +
  testOverlap * 10 +
  semanticConflictProbability * 30;

Suggested behavior:

0-20: Run concurrently

21-45: Run concurrently with notifications

46-70: Sequence integration

71-100: Block and request resolution

These thresholds must remain configurable.

They should later be adjusted using observed outcomes.

17. Code Intelligence

Use deterministic parsers before using LLM reasoning.

Recommended technologies:

Tree-sitter

TypeScript Compiler API

Language Server Protocol

Python AST

Rust Analyzer

Java compiler tooling

Build system metadata

Maintain the following graphs.

Symbol graph

File → Class → Method → Referenced symbols

Dependency graph

Service → API → Package → Database table

Build graph

Package → Build target → Test suite → Artifact

Task graph

Task A → blocks Task B
Task C → consumes Task A output

Ownership graph

Agent X → owns Symbol Y until Time Z

Use LLMs only where deterministic analysis is insufficient.

18. Change Integration

Every completed task must produce a structured changeset.

interface ChangeSet {
  id: string;
  taskId: string;
  baseVersion: number;
  patches: FilePatch[];
  commandsRun: CommandResult[];
  tests: TestResult[];
  dependenciesChanged: string[];
  symbolsChanged: string[];
  riskAssessment: RiskAssessment;
  agentExplanation: string;
}

Integration sequence

Freeze the task overlay.

Compare it against the latest canonical version.

Recalculate conflicts.

Apply the changes to a temporary integration snapshot.

Compile.

Run affected tests.

Run linting.

Run security checks.

Run policy checks.

Request required approvals.

Atomically promote the snapshot.

Create a Git commit or checkpoint.

Notify dependent tasks.

Release resource ownership.

No task should directly mutate canonical state outside this process.

Version history, rollback, and review

Every promotion already creates a Git commit, so canonical history is a
product surface, not an internal detail. The following build on it and are
scoped for Phase 2:

History browsing. The dashboard and API expose the canonical version
timeline that promotions already produce: versions, the tasks and
changesets behind them, validation results, and approvals.

Rollback. Reverting to a previous canonical version is submitted as an
ordinary changeset: it is conflict-checked against in-flight work,
validated in an integration snapshot, approved where policy requires, and
promoted atomically. A rollback is never a raw Git reset, so it is
audited, blockable, and safe against concurrent tasks like any other
change.

Review threads. Approvals gain positioned comment threads on changeset
diffs, so review is a conversation rather than a single diff-and-decide
gate.

Task boards. Issue-style board views are projections of the existing task
submission queue, not a second tracking system.

Scope boundary: these features surface Git history through the
coordinator. Direct branch, merge, or reset access to the canonical
repository outside the integration pipeline is intentionally not offered,
in any phase. That is a design boundary, not a missing feature: an
uncoordinated write path would reintroduce exactly the race conditions and
corrupted merges the platform exists to prevent. Read-only Git access,
history, and export remain guaranteed.

19. Real-Time Collaboration Streams

Keep these streams separate.

Presence stream

Contains:

Active users

Active agents

Current files

Current tasks

Cursor location

Availability

Canonical code stream

Contains:

Approved file changes

New canonical versions

Integrated changesets

Rollbacks

Task overlay stream

Contains:

In-progress edits

Agent progress

Proposed diffs

Unapproved changes

This separation prevents unfinished work from being mistaken for accepted code.

20. Security Requirements

Treat every coding agent as an untrusted workload.

Required controls:

One isolated environment per task

Read-only canonical repository mount

Write access only to task overlays

No host filesystem access

No Docker socket access

Deny outbound network access by default

Explicit network allowlists

Short-lived credentials

Per-task secrets

CPU limits

Memory limits

Disk limits

Execution timeouts

Command logging

Dependency scanning

Malware scanning

Signed artifacts

Encrypted storage

Immutable audit records

Example policy

policy:
  agent: claude-code
  repository: payments-service

  permissions:
    read:
      - "src/**"
      - "tests/**"

    write:
      - "src/payments/**"
      - "tests/payments/**"

    deny:
      - ".github/workflows/**"
      - "infrastructure/production/**"
      - "secrets/**"

    network:
      allow:
        - "registry.npmjs.org"

    require_human_approval:
      - "database/migrations/**"
      - "package.json"
      - "authentication/**"

21. Deployment Models

Managed cloud

The company operates:

Control plane

Coordinator

Compute

Storage

Agent gateway

Event infrastructure

Best for small teams and startups.

Hybrid

The company operates:

Licensing

Account management

Optional global control services

The customer operates:

Source code

Execution workers

Build systems

Secrets

Audit storage

Possibly the coordinator data plane

This may be the strongest enterprise model.

Fully on-premises

Everything runs inside customer infrastructure.

Provide:

Helm charts

Kubernetes operators

Terraform modules

Signed release bundles

Offline installation packages

Upgrade tooling

Backup tooling

Local-network appliance mode

For smaller private teams:

Local coordinator server
├── PostgreSQL
├── Redis
├── Event service
├── Workspace worker
├── Git mirror
└── Web interface

Other users connect over the local network.

External AI access should pass through a controlled gateway.

22. Core Database Model

Suggested initial tables:

organizations
users
principals
projects
repositories
environments
tasks
task_dependencies
agent_sessions
workspaces
resources
resource_leases
changesets
canonical_versions
conflicts
approvals
policies
audit_events
usage_records

Important entities should use immutable IDs.

Task state transitions and integration events should be preserved as append-only records where practical.

23. MVP Scope

The MVP must answer one question:

Can coordinated agents complete parallel software work with less rework than independent agents using ordinary Git workflows?

Required MVP features

GitHub repository import

Two coding-agent adapters

Task submission

Agent plan submission

Prediction of expected file changes

File overlap detection

File-level ownership

Isolated Docker workspaces

Live task status

Diff collection

Automated tests

Sequential atomic integration

Git commit creation

Basic conflict warnings

Human approval

Audit timeline

Do not include in the first MVP

Full cloud IDE

Real-time collaborative text editing

Symbol-level ownership

Air-gapped deployment

Semantic conflict resolution

Dozens of languages

Mobile coding

Enterprise compliance certifications

Complex billing

Custom model hosting

Full GitHub replacement

Multi-region Kubernetes infrastructure

24. First Build Order

Build in this exact order unless user evidence strongly suggests otherwise.

Create a CLI coordinator.

Implement two agent adapters.

Import a test repository.

Create two tasks.

Require both agents to submit plans.

Record expected file changes.

Detect overlapping files.

Grant temporary file-level leases.

Give each task one isolated Docker workspace.

Allow agents to edit only their own workspace.

Collect diffs.

Run repository tests.

Integrate the first successful changeset.

Update the canonical version.

Replay or rebase the second changeset.

Record conflicts and rework.

Compare coordinated and uncoordinated execution.

Add a minimal web dashboard once the command-line workflow works.

After the coordination loop is proven, continue with:

Human approvals.

Symbol indexing.

Task dependency tracking.

Piloting with real teams.

Do not start by building a polished browser IDE.

The coordinator is the product.

The editor is a surface.

25. Development Phases

Phase 0: Technical Proof

Target:

CLI coordinator

Two agents

Docker workspaces

File ownership

Git integration

Basic tests

Success condition:

Two agents complete a predefined task without corrupting each other's work.

Phase 1: MVP

Add:

Web dashboard

Authentication

Repository import

Task management

Diff review

Agent status

Integration history

Success condition:

Several small teams use the product on noncritical projects.

Phase 2: Private Beta

Add:

Symbol-level coordination

Policy engine

Customer-hosted workers

Cost controls

Better audit logs

Canonical version history browsing in the dashboard and API

Pipeline-safe rollback to a previous canonical version

Review comment threads on changeset diffs

Issue and task-board views over the task queue

Reliability and recovery

Success condition:

Real teams demonstrate measurable reductions in integration work.

Phase 3: Production Platform

Add:

Kubernetes execution

High availability

Enterprise SSO

Hybrid deployment

Stronger security

SDK

Public agent protocol

Phase 4: Full AI-Native Development Platform

Add:

Intent-level coordination

Cross-repository planning

Learned scheduling

Enterprise on-premises control plane

Air-gapped support

Architectural policy enforcement

Global engineering dependency graph

26. Product Metrics

Track the following from the first prototype.

Coordination metrics

Conflict predictions

True conflicts

False positives

Missed conflicts

Average blocked time

Average ownership duration

Parallel tasks completed

Productivity metrics

Time from request to accepted integration

Rework avoided

Human review time

Integration failures

Rollbacks

Percentage of tasks completed without intervention

Reliability metrics

Workspace startup time

Build failure rate

Test failure rate

Integration latency

Coordinator uptime

Agent failure rate

Cost metrics

Model cost per task

Compute cost per task

Cost per accepted changeset

Idle workspace cost

Cost by agent provider

The most important benchmark is:

Coordinated agents versus uncoordinated agents on the same repository and task set.

27. Product Design Rules

Humans must be able to override coordinator decisions.

Every blocking decision must include an explanation.

Canonical state changes must be atomic.

Agent work must be isolated by default.

Git export must always remain possible.

Rollback must ride the integration pipeline, never a raw Git reset.

Direct branch or merge access to canonical outside the coordinator is
intentionally unsupported; read-only history and export remain guaranteed.

Provider-specific capabilities must be optional.

The fast coordination path should not require an LLM.

LLM reasoning should be used only for ambiguous semantic cases.

Security policies must be enforced outside the agent.

The system must degrade safely when services fail.

Unfinished work must never appear as accepted code.

Every action must be auditable.

The coordinator must minimize interruption, not maximize control.

The product must prove measurable gains before expanding scope.

28. Reliability and Failure Behavior

The platform must define behavior for:

Coordinator outage

Database outage

Event service outage

Agent provider outage

Workspace crash

Build failure

Test failure

Lost network connection

Expired ownership lease

Stale base version

Partial integration

Corrupted workspace

External Git changes

Recommended fallback behavior:

Preserve task state

Stop canonical writes

Allow read-only access

Keep local Git mirrors current

Resume from durable event history

Never silently discard agent work

Provide repository export

Allow administrators to recover manually

29. Suggested Repository Structure

coordinator-platform/
├── apps/
│   ├── web/
│   ├── admin/
│   └── cli/
│
├── services/
│   ├── api-gateway/
│   ├── coordinator/
│   ├── workspace-manager/
│   ├── agent-gateway/
│   ├── repository-service/
│   ├── integration-service/
│   ├── policy-service/
│   ├── code-intelligence/
│   └── audit-service/
│
├── packages/
│   ├── agent-protocol/
│   ├── event-schema/
│   ├── shared-types/
│   ├── code-indexer/
│   ├── git-utils/
│   └── ui-components/
│
├── adapters/
│   ├── claude-code/
│   ├── codex/
│   ├── gemini/
│   └── generic-cli/
│
├── infrastructure/
│   ├── docker/
│   ├── kubernetes/
│   ├── terraform/
│   └── local/
│
├── examples/
│   └── demo-project/
│
└── docs/
    ├── architecture/
    ├── protocol/
    ├── security/
    ├── deployment/
    └── benchmarks/

30. Instructions for AI Coding Agents

When an AI coding agent works on this project, it should follow these rules.

Before editing

The agent must:

Read this document.

Read the repository architecture documentation.

Identify the requested outcome.

List expected files and symbols.

Identify dependencies and risks.

Propose a plan.

Avoid editing until the plan is accepted when coordination is enabled.

During implementation

The agent must:

Stay within approved scope.

Report scope expansion.

Avoid unrelated refactors.

Preserve API compatibility unless explicitly authorized.

Add tests for new behavior.

Run relevant tests.

Keep services loosely coupled.

Use typed event and API schemas.

Avoid provider-specific assumptions in core services.

Preserve auditability.

Use transactional integration paths.

Before completion

The agent must report:

Files changed

Symbols changed

Dependencies changed

Commands run

Tests run

Known limitations

Security implications

Migration requirements

Follow-up work

Agent completion format

Summary:
- What was implemented

Files changed:
- path/to/file

Symbols changed:
- symbolName

Validation:
- command
- result

Risks:
- identified risk

Follow-up:
- remaining work

31. Critical Understanding Check

Before writing code, an agent working on this project should be able to state, in its own words:

Why this product is not just another coding agent.

Why it is not limited to one desktop.

Why coding agents need isolated task workspaces.

Why the canonical codebase cannot be edited directly by an agent.

How the coordinator differs from a ticket manager.

How temporary ownership works.

How changes become canonical.

Why Git still exists underneath the platform.

What the first MVP must prove.

What should deliberately not be built yet.

An agent that cannot answer these should re-read this document before making changes.

32. Instructions for Human Developers

Human developers should:

Keep tasks small and explicit.

Describe intent, not only filenames.

Avoid bypassing the integration pipeline.

Use overrides only when necessary.

Review coordinator false positives.

Report missed conflicts.

Preserve compatibility across agent adapters.

Prefer deterministic logic over LLM calls.

Add observability to every new service.

Design for on-premises deployment even when building cloud-first.

Maintain normal Git export and rollback paths.

33. Architectural Decision Priorities

When choosing between designs, prioritize in this order:

Safety of canonical code

Recoverability

Developer trust

Coordination correctness

Low latency

Agent neutrality

Deployment flexibility

Operability

Cost efficiency

Interface polish

The product should never sacrifice canonical code safety for a more impressive demo.

34. Long-Term Defensibility

The strongest potential defensible assets are:

Agent Coordination Protocol

Historical coordination outcomes

Conflict prediction data

Code and task dependency graphs

Enterprise deployment infrastructure

Policy and security controls

Agent adapter ecosystem

Workflow benchmarks

Learned scheduling models

The editor is not the moat.

Basic task orchestration is not the moat.

The long-term moat is:

Knowing how to safely schedule, constrain, validate, and integrate heterogeneous agent work better than any competing platform.

35. Immediate Next Milestone

The first milestone should demonstrate:

One repository

Two coding agents

Two parallel tasks

Plan submission

File-level collision detection

Isolated workspaces

Automated tests

Ordered integration

Git checkpoints

A measurable comparison against uncoordinated execution

The project should not move to a broader platform build until this experiment produces evidence that coordination meaningfully reduces rework or completion time.

36. Final Product Statement

The product should be described internally as:

An AI-native software development coordination platform that allows humans and heterogeneous coding agents to work against a continuously managed canonical codebase through isolated execution, predictive conflict detection, temporary ownership, policy enforcement, and transactional integration.

A simpler external positioning may be:

The coordination layer for AI software engineering.