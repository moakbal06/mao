/**
 * tracker-jira plugin — Atlassian Jira as an issue tracker.
 *
 * Uses the Jira REST API v3 (Cloud) for all interactions.
 *
 * Required env vars:
 *   JIRA_BASE_URL   — e.g. https://yoursite.atlassian.net
 *   JIRA_EMAIL       — Atlassian account email
 *   JIRA_API_TOKEN   — API token from https://id.atlassian.com/manage-profile/security/api-tokens
 *
 * Optional project-level config in agent-orchestrator.yaml:
 *   tracker:
 *     plugin: jira
 *     projectKey: "PROJ"           — Jira project key for listing/creating issues
 *     readyLabel: "ready-for-ai"   — Default label filter when listIssues has no labels
 *     assignee: "currentUser()"    — Default assignee filter when listIssues has no assignee
 *     jql: "type = Bug"            — Base JQL filter (ANDed with listIssues filters)
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@moakbal/mao-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `tracker-jira: missing required environment variable ${name}`,
    );
  }
  return val;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.toLowerCase();
  if (normalized === "undefined" || normalized === "null") return undefined;
  return trimmed;
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function quoteJqlString(value: string): string {
  return `"${escapeJqlString(value)}"`;
}

function formatLabelsJql(labels: string[]): string | null {
  const cleaned = labels
    .map((label) => asNonEmptyString(label))
    .filter((label): label is string => Boolean(label));
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) {
    return `labels = ${quoteJqlString(cleaned[0])}`;
  }
  return `labels in (${cleaned.map((label) => quoteJqlString(label)).join(", ")})`;
}

function formatAssigneeJql(assignee: string): string | null {
  const trimmed = assignee.trim();
  if (!trimmed) return null;
  if (/^currentUser\(\)$/i.test(trimmed)) {
    return "assignee = currentUser()";
  }
  if (/^unassigned$/i.test(trimmed)) {
    return "assignee is EMPTY";
  }
  return `assignee = ${quoteJqlString(trimmed)}`;
}

interface JiraResponse<T> {
  data: T;
  status: number;
}

async function jiraApi<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<JiraResponse<T>> {
  const baseUrl = getEnv("JIRA_BASE_URL").replace(/\/$/, "");
  const email = getEnv("JIRA_EMAIL");
  const token = getEnv("JIRA_API_TOKEN");

  const url = new URL(`/rest/api/3${path}`, baseUrl);
  const auth = Buffer.from(`${email}:${token}`).toString("base64");

  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const init: RequestInit = {
    method,
    headers,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), init);
  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`Jira API ${method} ${path} returned ${res.status}: ${raw.slice(0, 500)}`);
  }

  try {
    const data = raw ? (JSON.parse(raw) as T) : ({} as T);
    return { data, status: res.status };
  } catch {
    throw new Error(`Jira API ${method} ${path}: invalid JSON response: ${raw.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Jira types (subset of v3 API)
// ---------------------------------------------------------------------------

interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary: string;
    description?: JiraAdfDoc | string | null;
    status: {
      name: string;
      statusCategory: {
        key: string; // "new" | "indeterminate" | "done"
      };
    };
    labels: string[];
    assignee?: {
      displayName: string;
      emailAddress?: string;
    } | null;
    priority?: {
      name: string;
      id: string;
    } | null;
    issuetype?: {
      name: string;
    };
  };
}

interface JiraAdfDoc {
  type: "doc";
  content: JiraAdfNode[];
}

interface JiraAdfNode {
  type: string;
  text?: string;
  content?: JiraAdfNode[];
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
}

// ---------------------------------------------------------------------------
// ADF → plain text
// ---------------------------------------------------------------------------

function adfToText(node: JiraAdfDoc | JiraAdfNode | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if ("text" in node && typeof node.text === "string") return node.text;
  if (!node.content) return "";
  return node.content.map((child) => adfToText(child)).join(node.type === "paragraph" ? "\n" : "");
}

function extractDescription(
  desc: JiraAdfDoc | string | null | undefined,
): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  return adfToText(desc);
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapState(
  statusCategory: string,
  statusName: string,
): Issue["state"] {
  const cat = statusCategory.toLowerCase();
  const name = statusName.toLowerCase();

  if (cat === "done") {
    if (name.includes("cancel") || name.includes("reject") || name.includes("won't")) {
      return "cancelled";
    }
    return "closed";
  }
  if (cat === "indeterminate" || name.includes("progress") || name.includes("review")) {
    return "in_progress";
  }
  return "open";
}

function mapPriority(priorityName?: string): number | undefined {
  if (!priorityName) return undefined;
  const name = priorityName.toLowerCase();
  if (name.includes("highest") || name.includes("blocker")) return 0;
  if (name.includes("high") || name.includes("critical")) return 1;
  if (name.includes("medium") || name.includes("normal")) return 2;
  if (name.includes("low")) return 3;
  if (name.includes("lowest") || name.includes("trivial")) return 4;
  return undefined;
}

function toIssue(jira: JiraIssue): Issue {
  const baseUrl = getEnv("JIRA_BASE_URL").replace(/\/$/, "");
  return {
    id: jira.key,
    title: jira.fields.summary,
    description: extractDescription(jira.fields.description),
    url: `${baseUrl}/browse/${jira.key}`,
    state: mapState(
      jira.fields.status.statusCategory.key,
      jira.fields.status.name,
    ),
    labels: jira.fields.labels ?? [],
    assignee: jira.fields.assignee?.displayName,
    priority: mapPriority(jira.fields.priority?.name),
  };
}

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

interface JiraTransition {
  id: string;
  name: string;
  to: {
    statusCategory: {
      key: string;
    };
  };
}

async function findTransition(
  issueKey: string,
  targetCategoryKey: string,
): Promise<JiraTransition | undefined> {
  const { data } = await jiraApi<{ transitions: JiraTransition[] }>(
    "GET",
    `/issue/${issueKey}/transitions`,
  );
  return data.transitions.find(
    (t) =>
      t.to.statusCategory.key.toLowerCase() ===
      targetCategoryKey.toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Text → ADF conversion
// ---------------------------------------------------------------------------

function textToAdf(text: string): JiraAdfDoc {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(
      identifier: string,
      _project: ProjectConfig,
    ): Promise<Issue> {
      const { data } = await jiraApi<JiraIssue>(
        "GET",
        `/issue/${identifier}?fields=summary,description,status,labels,assignee,priority,issuetype`,
      );
      return toIssue(data);
    },

    async isCompleted(
      identifier: string,
      _project: ProjectConfig,
    ): Promise<boolean> {
      const { data } = await jiraApi<JiraIssue>(
        "GET",
        `/issue/${identifier}?fields=status`,
      );
      return data.fields.status.statusCategory.key.toLowerCase() === "done";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      const baseUrl = getEnv("JIRA_BASE_URL").replace(/\/$/, "");
      return `${baseUrl}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // https://yoursite.atlassian.net/browse/PROJ-123 → "PROJ-123"
      const match = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i);
      if (match) return match[1];
      const parts = url.split("/");
      return parts[parts.length - 1] ?? url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // PROJ-123 → feat/PROJ-123
      return `feat/${identifier}`;
    },

    async generatePrompt(
      identifier: string,
      project: ProjectConfig,
    ): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Jira issue ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          0: "Highest",
          1: "High",
          2: "Medium",
          3: "Low",
          4: "Lowest",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? "Unknown"}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(
      filters: IssueFilters,
      project: ProjectConfig,
    ): Promise<Issue[]> {
      const trackerConfig = project.tracker as Record<string, unknown> | undefined;
      const projectKey = asNonEmptyString(trackerConfig?.projectKey);
      const readyLabel = asNonEmptyString(trackerConfig?.readyLabel);
      const defaultAssignee = asNonEmptyString(trackerConfig?.assignee);
      const baseJql = asNonEmptyString(trackerConfig?.jql);

      const labelFilter =
        filters.labels && filters.labels.length > 0
          ? filters.labels
          : filters.labels === undefined && readyLabel
            ? [readyLabel]
            : undefined;

      const assigneeFilter = filters.assignee ?? defaultAssignee;

      const jqlParts: string[] = [];

      if (baseJql) {
        jqlParts.push(`(${baseJql})`);
      }

      if (projectKey) {
        jqlParts.push(`project = ${quoteJqlString(projectKey)}`);
      }

      if (filters.state === "closed") {
        jqlParts.push("statusCategory = Done");
      } else if (filters.state !== "all") {
        // Default to open issues
        jqlParts.push("statusCategory != Done");
      }

      if (labelFilter) {
        const labelsJql = formatLabelsJql(labelFilter);
        if (labelsJql) jqlParts.push(labelsJql);
      }

      if (assigneeFilter) {
        const assigneeJql = formatAssigneeJql(assigneeFilter);
        if (assigneeJql) jqlParts.push(assigneeJql);
      }

      const jql = jqlParts.length > 0 ? jqlParts.join(" AND ") : "order by created DESC";
      const maxResults = filters.limit ?? 30;

      const { data } = await jiraApi<JiraSearchResult>(
        "POST",
        `/search/jql`,
        {
          jql,
          maxResults,
          fields: [
            "summary",
            "description",
            "status",
            "labels",
            "assignee",
            "priority",
            "issuetype",
          ],
        },
      );

      return data.issues.map(toIssue);
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Handle state change via transitions
      if (update.state) {
        let targetCategory: string;
        if (update.state === "closed") {
          targetCategory = "done";
        } else if (update.state === "in_progress") {
          targetCategory = "indeterminate";
        } else {
          targetCategory = "new";
        }

        const transition = await findTransition(identifier, targetCategory);
        if (transition) {
          await jiraApi("POST", `/issue/${identifier}/transitions`, {
            transition: { id: transition.id },
          });
        }
      }

      // Handle label changes (Jira uses PUT to update fields)
      if (
        (update.labels && update.labels.length > 0) ||
        (update.removeLabels && update.removeLabels.length > 0)
      ) {
        // Get current labels first
        const { data: current } = await jiraApi<JiraIssue>(
          "GET",
          `/issue/${identifier}?fields=labels`,
        );
        let labels = current.fields.labels ?? [];

        if (update.removeLabels) {
          const removeSet = new Set(update.removeLabels);
          labels = labels.filter((l) => !removeSet.has(l));
        }

        if (update.labels) {
          const existing = new Set(labels);
          for (const l of update.labels) {
            if (!existing.has(l)) {
              labels.push(l);
            }
          }
        }

        await jiraApi("PUT", `/issue/${identifier}`, {
          fields: { labels },
        });
      }

      // Handle assignee
      if (update.assignee) {
        // Search for user by display name
        const { data: users } = await jiraApi<
          Array<{ accountId: string; displayName: string }>
        >("GET", `/user/search?query=${encodeURIComponent(update.assignee)}&maxResults=1`);

        if (users.length > 0) {
          await jiraApi("PUT", `/issue/${identifier}/assignee`, {
            accountId: users[0].accountId,
          });
        }
      }

      // Handle comment
      if (update.comment) {
        await jiraApi("POST", `/issue/${identifier}/comment`, {
          body: textToAdf(update.comment),
        });
      }
    },

    async createIssue(
      input: CreateIssueInput,
      project: ProjectConfig,
    ): Promise<Issue> {
      const projectKey =
        (project.tracker as Record<string, unknown> | undefined)
          ?.projectKey as string | undefined;

      if (!projectKey) {
        throw new Error(
          "tracker-jira: createIssue requires tracker.projectKey in config",
        );
      }

      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary: input.title,
        issuetype: { name: "Task" },
      };

      if (input.description) {
        fields.description = textToAdf(input.description);
      }

      if (input.labels && input.labels.length > 0) {
        fields.labels = input.labels;
      }

      const { data } = await jiraApi<{ key: string }>("POST", "/issue", {
        fields,
      });

      // Assign if requested
      if (input.assignee) {
        const { data: users } = await jiraApi<
          Array<{ accountId: string }>
        >(
          "GET",
          `/user/search?query=${encodeURIComponent(input.assignee)}&maxResults=1`,
        );
        if (users.length > 0) {
          await jiraApi("PUT", `/issue/${data.key}/assignee`, {
            accountId: users[0].accountId,
          });
        }
      }

      return this.getIssue(data.key, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Atlassian Jira (Cloud)",
  version: "0.1.0",
};

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
