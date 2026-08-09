## Decision Memo: Modular Restructuring for Open-Source AI Coding-Agent Platform

**Date:** 2026-08-09

**Objective:** To provide recommendations for modular restructuring of an open-source AI coding-agent platform, focusing on repository structure, component packaging, decision locking, and acceptance criteria for independence.

**1. Repository Separation Strategy:**

*   **Recommendation:** Postpone physical repository separation until after a stable release (e.g., post-0.2.0). Focus on establishing strong internal modularity within the current repository first.
*   **Rationale:** Significant architectural refactoring (like splitting repositories) introduces churn and review hazards that are best avoided before a stable baseline is achieved. This aligns with the principle of establishing a solid foundation before extensive decomposition (5).
*   **Measurable Extraction Triggers:**
    *   **Independent Deployability:** A component or agent group demonstrates clear functional boundaries and can be deployed and scaled independently of the core platform.
    *   **Significant Inter-Component Dependency:** The complexity of managing dependencies between a component and the core platform becomes a bottleneck, indicating that extraction would simplify management.
    *   **Team Ownership:** A specific team or sub-project is solely responsible for a set of functionalities, making independent development and release cycles beneficial.

**2. PR/Milestone Decomposition:**

*   **Recommendation:** Decompose work into small, focused Pull Requests (PRs) aligned with specific agent capabilities or user-facing features. Prioritize incremental delivery of modular components.
*   **Rationale:** Large changes increase review latency and complexity (1, 10). Breaking down work into smaller PRs facilitates easier review, reduces the risk of merge conflicts, and allows for continuous integration of modular pieces. This supports a "vertical slice" approach where complete, albeit small, features or functionalities are delivered incrementally (4).
*   **Milestone Decomposition (Conceptual):**
    *   **Milestone 1 (Core Orchestration):** Focus on establishing the fundamental agent orchestration pattern (e.g., multi-agent, event-driven) and basic communication protocols. PRs will be small, focusing on defining agent interfaces and core workflow logic.
        *   *PR Size:* Small (1-3 files, <100 LoC per PR)
        *   *Surface Area:* Agent communication protocols, core workflow manager.
    *   **Milestone 2 (Memory & Tool Integration):** Implement and integrate the chosen memory/persistence mechanism and initial set of core tools. PRs will focus on abstracting tool interfaces and integrating the memory module.
        *   *PR Size:* Small to Medium (2-5 files, <200 LoC per PR)
        *   *Surface Area:* Memory management module, tool abstraction layer.
    *   **Milestone 3 (Agent Specialization):** Develop and integrate specialized agents (e.g., code analysis, test generation, refactoring agents). PRs will focus on individual agent logic and their integration points.
        *   *PR Size:* Medium (3-7 files, <300 LoC per PR)
        *   *Surface Area:* Individual agent modules, agent registry.
    *   **Milestone 4 (Modular Extraction Planning):** Based on defined triggers, plan and prototype the extraction of the first set of independent services.
        *   *PR Size:* Small (focus on planning and initial extraction code)
        *   *Surface Area:* Service boundary definitions, initial extraction scripts.

**3. Component Packaging (Modular-Monolith vs. Services):**

*   **Recommendation:** Adopt a modular-monolith strategy initially. Package core orchestration, shared utilities, and tightly coupled agent functionalities within a single deployable unit. Extract highly specialized, independently scalable agents or functionalities into separate services later.
*   **Rationale:** A modular-monolith allows for internal modularity and separation of concerns without the immediate overhead of managing multiple distributed services (5, 12). This approach provides flexibility, allowing for gradual extraction as components mature and demonstrate independent value (25, 26, 30).
*   **Modular-Monolith Components:** Core agent orchestrator, shared context management, fundamental memory/persistence interfaces, common utility functions, tightly coupled agent groups (e.g., agents working on the same file or task).
*   **Future Services:** Highly specialized agents (e.g., advanced code generation, specific domain analysis), independently scalable components (e.g., a dedicated search agent), or components requiring different technology stacks.

**4. Decision Locking (Now vs. Postponed):**

*   **Decisions to Lock Now:**
    *   **Core Orchestration Pattern:** Multi-agent vs. single-agent, event-driven vs. direct invocation (25, 26, 34).
    *   **Primary Memory/Persistence Strategy:** How agent state and context are stored and retrieved (LangChain memory docs, prior sources).
    *   **Core Communication Protocols:** How agents and components interact (e.g., A2A Protocol, gRPC, REST) (prior sources).
    *   **Modularity Principles:** Adherence to defined module boundaries and interfaces (21).
*   **Decisions to Postpone:**
    *   **Specific LLM Provider Integration:** While supporting multiple providers is good (32), locking into one for the core platform might be premature. Focus on abstraction.
    *   **Detailed Tool Integrations:** Specific implementations of external tools can be added iteratively.
    *   **UI/UX specific details:** Unless directly impacting core agent functionality.
*   **Rationale:** "Screaming Architecture" principles suggest deferring environmental decisions (8). Core architectural decisions provide the necessary structure for modular development, while others can be adapted as the platform evolves.

**5. Acceptance Metrics for Independence (Without Physical Repo Split):**

*   **Recommendation:** Utilize internal metrics and testing strategies to validate modular independence before physical repository separation.
*   **Metrics:**
    *   **Unit & Integration Test Coverage:** Achieve high test coverage for individual modules/agents, ensuring they can be tested in isolation with mocked dependencies.
    *   **Dependency Graph Analysis:** Visualize and enforce module dependencies. Aim for a clear, directed graph with minimal cross-module coupling (21). Tools like Nx can help enforce these constraints (21).
    *   **Contract Testing:** Implement tests that verify the adherence of components to their defined interfaces and communication protocols.
    *   **Code Complexity Metrics:** Monitor cyclomatic complexity and lines of code within modules. Smaller, contained changes indicate better modularity.
    *   **Performance Benchmarks:** Measure the performance of individual modules or agent workflows to ensure they meet requirements and do not introduce performance regressions in other parts of the system.
    *   **Documentation:** Maintain clear documentation for each module's API, responsibilities, and dependencies.
*   **Rationale:** These metrics provide objective evidence of modularity and independence, allowing for confident refactoring and eventual extraction without the immediate overhead of managing separate repositories (25, 26).