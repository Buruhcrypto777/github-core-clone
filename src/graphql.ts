// GitHub GraphQL v4: a small parser + executor for exactly the documents gh and
// github-mcp-server send (see checks-graphql.ts). No external dependency.

import {
  mergeableOf,
  pullFiles,
  resolveRefToCommit,
  threeWayMerge,
  globalId,
  type RestContext,
} from './rest.ts';
import {
  buildCommit,
  hashObject,
  isObjectId,
  parseCommit,
  REST_EPOCH_SEC,
  VIEWER,
  VIEWER_IDENTITY,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

type SelectionNode =
  | { kind: 'Field'; alias: string; name: string; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'InlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string };

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: Array<{ name: string; type: string }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Block strings (""") are not used by the suite; a plain string is.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc ?? '';
          j += 2;
          continue;
        }
        out += input[j];
        j += 1;
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, varDefs, selections });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      throw new Error(`unexpected token ${token.value} in document`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): Array<{ name: string; type: string }> {
    const defs: Array<{ name: string; type: string }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        defs.push({ name, type });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): string {
    let type: string;
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = `[${inner}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        return { kind: 'FragmentSpread', name };
      }
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite; skip them if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'int') return { kind: 'Int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'Float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------------------------

interface FieldDef {
  name: string;
  description?: string;
}

const SCHEMA_FIELDS: Record<string, FieldDef[]> = {
  Query: [
    { name: 'viewer' }, { name: 'repository' }, { name: 'node' }, { name: '__type' }, { name: '__schema' },
  ],
  Mutation: [
    { name: 'createIssue' }, { name: 'closeIssue' }, { name: 'createPullRequest' }, { name: 'mergePullRequest' }, { name: 'addComment' },
  ],
  User: [{ name: 'id' }, { name: 'login' }, { name: 'name' }, { name: 'email' }],
  Repository: [
    { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' },
    { name: 'description' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' },
    { name: 'isPrivate' }, { name: 'url' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequest' }, { name: 'pullRequests' },
    { name: 'createdAt' }, { name: 'updatedAt' },
  ],
  Ref: [{ name: 'name' }, { name: 'target' }],
  Issue: [
    { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'body' }, { name: 'state' },
    { name: 'author' }, { name: 'repository' }, { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'closedAt' }, { name: 'comments' },
  ],
  IssueConnection: [{ name: 'nodes' }, { name: 'edges' }, { name: 'pageInfo' }, { name: 'totalCount' }],
  IssueEdge: [{ name: 'node' }, { name: 'cursor' }],
  PullRequest: [
    { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'body' }, { name: 'state' },
    { name: 'merged' }, { name: 'mergeable' }, { name: 'headRefName' }, { name: 'baseRefName' },
    { name: 'headRef' }, { name: 'baseRef' }, { name: 'files' }, { name: 'author' }, { name: 'repository' },
    { name: 'createdAt' }, { name: 'mergedAt' },
  ],
  PullRequestConnection: [{ name: 'nodes' }, { name: 'edges' }, { name: 'pageInfo' }, { name: 'totalCount' }],
  PullRequestEdge: [{ name: 'node' }, { name: 'cursor' }],
  PullRequestChangedFile: [{ name: 'path' }, { name: 'additions' }, { name: 'deletions' }, { name: 'changes' }],
  /** Validation-only union: a PullRequestConnection's nodes are PullRequests, except a PR's files connection. */
  PullRequestConnectionNode: [
    { name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'body' }, { name: 'state' },
    { name: 'merged' }, { name: 'mergeable' }, { name: 'headRefName' }, { name: 'baseRefName' },
    { name: 'headRef' }, { name: 'baseRef' }, { name: 'files' }, { name: 'author' }, { name: 'repository' },
    { name: 'createdAt' }, { name: 'mergedAt' },
    { name: 'path' }, { name: 'additions' }, { name: 'deletions' }, { name: 'changes' },
  ],
  PageInfo: [{ name: 'hasNextPage' }, { name: 'hasPreviousPage' }, { name: 'startCursor' }, { name: 'endCursor' }],
  Node: [{ name: 'id' }],
  CreateIssuePayload: [{ name: 'issue' }, { name: 'clientMutationId' }],
  CloseIssuePayload: [{ name: 'issue' }, { name: 'clientMutationId' }],
  CreatePullRequestPayload: [{ name: 'pullRequest' }, { name: 'clientMutationId' }],
  MergePullRequestPayload: [{ name: 'pullRequest' }, { name: 'clientMutationId' }],
  AddCommentPayload: [{ name: 'commentEdge' }, { name: 'clientMutationId' }],
  IssueComment: [{ name: 'id' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }],
  CommentEdge: [{ name: 'node' }, { name: 'cursor' }],
  __Type: [{ name: 'name' }, { name: 'kind' }, { name: 'description' }, { name: 'fields' }, { name: 'enumValues' }, { name: 'inputFields' }],
  __Field: [{ name: 'name' }, { name: 'description' }, { name: 'args' }, { name: 'type' }],
  __EnumValue: [{ name: 'name' }, { name: 'description' }],
  __InputValue: [{ name: 'name' }, { name: 'description' }, { name: 'type' }],
  __Schema: [{ name: 'types' }, { name: 'queryType' }, { name: 'mutationType' }, { name: 'description' }],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

const SCHEMA_INPUTS: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
};

function typeKind(name: string): string {
  if (SCHEMA_ENUMS[name] !== undefined) return 'ENUM';
  if (SCHEMA_INPUTS[name] !== undefined) return 'INPUT_OBJECT';
  if (SCHEMA_FIELDS[name] !== undefined) return 'OBJECT';
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') return 'SCALAR';
  return 'OBJECT';
}

function fieldNamesOf(type: string): string[] {
  return (SCHEMA_FIELDS[type] ?? []).map((field) => field.name);
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { __typename: string; [key: string]: unknown }
  | string
  | number
  | boolean
  | null;

interface ExecutorContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name] ?? null;
    case 'String':
    case 'Enum':
      return node.value;
    case 'Int':
    case 'Float':
      return node.value;
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'List':
      return node.values.map((item) => valueOf(item, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts[0] ?? '';
    if (kind === '') return null;
    return { kind, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}

function userValue(): GqlValue {
  return { __typename: 'User' };
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

interface IssueListArgs {
  first?: number;
  states?: string[];
  orderBy?: { field?: string; direction?: string };
  after?: string | null;
}

function issuesConnection(ctx: ExecutorContext, repo: Repo, args: Record<string, unknown>): GqlValue {
  const listArgs = args as unknown as IssueListArgs;
  let issues = [...repo.issues.values()];
  if (Array.isArray(listArgs.states) && listArgs.states.length > 0) {
    const wanted = new Set(listArgs.states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const direction = listArgs.orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => {
    const bySeq = (a.seq - b.seq) * direction;
    if (bySeq !== 0) return bySeq;
    return (a.number - b.number) * direction;
  });
  const afterNumber = numberOfCursor(typeof listArgs.after === 'string' ? listArgs.after : null);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = typeof listArgs.first === 'number' ? listArgs.first : issues.length;
  const hasNextPage = issues.length > first;
  const nodes = issues.slice(0, first);
  const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    __itemType: 'Issue',
    nodes: nodes.map((issue) => issueValue(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: nodes.length > 0 ? cursorFor(nodes[0]!.number) : null,
      endCursor,
    },
    totalCount: issues.length,
  };
}

function pullsConnection(ctx: ExecutorContext, repo: Repo, args: Record<string, unknown>): GqlValue {
  const first = typeof args.first === 'number' ? (args.first as number) : undefined;
  let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.seq - a.seq);
  if (first !== undefined) pulls = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    __itemType: 'PullRequest',
    nodes: pulls.map((pull) => pullValue(repo, pull)),
    pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: pulls.length,
  };
}

function resolveNode(ctx: ExecutorContext, id: string): GqlValue | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
    return repo ? repoValue(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    return repo && issue ? issueValue(repo, issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    return repo && pull ? pullValue(repo, pull) : null;
  }
  if (decoded.kind === 'IssueComment') {
    const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
    const list = repo?.comments.get(Number(decoded.parts[1])) ?? [];
    const comment = list.find((entry) => entry.id === Number(decoded.parts[2]));
    return repo && comment ? { __typename: 'IssueComment', repo, issueNumber: Number(decoded.parts[1]), comment } : null;
  }
  return null;
}

function resolveType(name: string): GqlValue | null {
  if (SCHEMA_FIELDS[name] === undefined && SCHEMA_ENUMS[name] === undefined && SCHEMA_INPUTS[name] === undefined) return null;
  return { __typename: '__Type', typeName: name };
}

function executeSelections(
  ctx: ExecutorContext,
  parentType: string,
  parent: GqlValue,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      if (fragment.typeCondition !== parentType && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(ctx, parentType, parent, fragment.selections));
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType && selection.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelections(ctx, parentType, parent, selection.selections));
      continue;
    }
    const value = resolveField(ctx, parentType, parent, selection);
    out[selection.alias] = value === undefined ? null : value;
  }
  return out;
}

function resolveField(ctx: ExecutorContext, parentType: string, parent: GqlValue, selection: Extract<SelectionNode, { kind: 'Field' }>): unknown {
  if (selection.name === '__typename') return parentType;
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(selection.args)) args[name] = valueOf(node, ctx.variables);

  const sub = (value: GqlValue | null, type: string): unknown => {
    if (value === null) return null;
    if (selection.selections.length === 0) return value;
    return executeSelections(ctx, type, value, selection.selections);
  };

  if (parentType === 'Query') {
    if (selection.name === 'viewer') return sub(userValue(), 'User');
    if (selection.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? sub(repoValue(repo), 'Repository') : null;
    }
    if (selection.name === 'node') {
      const node = resolveNode(ctx, String(args.id ?? ''));
      if (node === null) return null;
      return sub(node, (node as { __typename: string }).__typename);
    }
    if (selection.name === '__type') {
      const type = resolveType(String(args.name ?? ''));
      return type ? sub(type, '__Type') : null;
    }
    if (selection.name === '__schema') {
      return sub({ __typename: '__Schema' }, '__Schema');
    }
    return null;
  }

  if (parentType === 'Mutation') {
    return resolveMutation(ctx, selection, args);
  }

  if (parent === null || typeof parent !== 'object') return null;
  const record = parent as { __typename: string; [key: string]: unknown };

  if (parentType === 'User') {
    if (selection.name === 'id') return globalId('User', VIEWER.id);
    if (selection.name === 'login') return VIEWER.login;
    if (selection.name === 'name') return VIEWER.name;
    if (selection.name === 'email') return VIEWER.email;
    return null;
  }

  if (parentType === 'Repository') {
    const repo = record.repo as Repo;
    switch (selection.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return sub(userValue(), 'User');
      case 'description':
        return repo.description;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : sub({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref');
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'isPrivate':
        return repo.private;
      case 'url':
        return '';
      case 'createdAt':
      case 'updatedAt':
        return '2025-01-01T00:00:00Z';
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? sub(issueValue(repo, issue), 'Issue') : null;
      }
      case 'issues':
        return sub(issuesConnection(ctx, repo, args), 'IssueConnection');
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? sub(pullValue(repo, pull), 'PullRequest') : null;
      }
      case 'pullRequests':
        return sub(pullsConnection(ctx, repo, args), 'PullRequestConnection');
      default:
        return null;
    }
  }

  if (parentType === 'Ref') {
    if (selection.name === 'name') return record.name ?? null;
    return null;
  }

  if (parentType === 'Issue') {
    const repo = record.repo as Repo;
    const issue = record.issue as Issue;
    switch (selection.name) {
      case 'id':
        return globalId('Issue', repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'author':
        return sub(userValue(), 'User');
      case 'repository':
        return sub(repoValue(repo), 'Repository');
      case 'createdAt':
      case 'updatedAt':
        return '2025-01-01T00:00:00Z';
      case 'closedAt':
        return issue.state === 'closed' ? '2025-01-01T00:00:00Z' : null;
      case 'comments': {
        const list = repo.comments.get(issue.number) ?? [];
        return sub(
          {
            __typename: 'IssueConnection',
            __itemType: 'IssueComment',
            nodes: list.map((comment) => ({ __typename: 'IssueComment', repo, issueNumber: issue.number, comment })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: list.length,
          },
          'IssueConnection',
        );
      }
      default:
        return null;
    }
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection') {
    const itemType = (record.__itemType as string | undefined) ?? (parentType === 'IssueConnection' ? 'Issue' : 'PullRequest');
    if (selection.name === 'nodes') {
      const nodes = (record.nodes ?? []) as GqlValue[];
      return nodes.map((node) => sub(node, itemType));
    }
    if (selection.name === 'edges') {
      const nodes = (record.nodes ?? []) as GqlValue[];
      const edgeType = itemType === 'Issue' ? 'IssueEdge' : itemType === 'PullRequest' ? 'PullRequestEdge' : 'PullRequestEdge';
      return nodes.map((node) => sub({ __typename: edgeType, node }, edgeType));
    }
    if (selection.name === 'pageInfo') return sub(record.pageInfo as GqlValue, 'PageInfo');
    if (selection.name === 'totalCount') return record.totalCount ?? 0;
    return null;
  }

  if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge') {
    if (selection.name === 'node') {
      const node = record.node as GqlValue;
      return sub(node, (node as { __typename: string }).__typename);
    }
    if (selection.name === 'cursor') return '';
    return null;
  }

  if (parentType === 'PageInfo') {
    if (selection.name === 'hasNextPage') return record.hasNextPage ?? false;
    if (selection.name === 'hasPreviousPage') return record.hasPreviousPage ?? false;
    if (selection.name === 'startCursor') return record.startCursor ?? null;
    if (selection.name === 'endCursor') return record.endCursor ?? null;
    return null;
  }

  if (parentType === 'PullRequest') {
    const repo = record.repo as Repo;
    const pull = record.pull as Pull;
    switch (selection.name) {
      case 'id':
        return globalId('PullRequest', repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return mergeableOf(repo, pull);
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'headRef':
        return sub({ __typename: 'Ref', name: pull.head }, 'Ref');
      case 'baseRef':
        return sub({ __typename: 'Ref', name: pull.base }, 'Ref');
      case 'files': {
        const first = typeof args.first === 'number' ? (args.first as number) : undefined;
        let files = pullFiles(repo, pull).map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));
        if (first !== undefined) files = files.slice(0, first);
        return sub(
          {
            __typename: 'PullRequestConnection',
            __itemType: 'PullRequestChangedFile',
            nodes: files,
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: files.length,
          },
          'PullRequestConnection',
        );
      }
      case 'author':
        return sub(userValue(), 'User');
      case 'repository':
        return sub(repoValue(repo), 'Repository');
      case 'createdAt':
        return '2025-01-01T00:00:00Z';
      case 'mergedAt':
        return pull.merged ? pull.mergedAt : null;
      default:
        return null;
    }
  }

  if (parentType === 'PullRequestChangedFile') {
    if (selection.name === 'path') return record.path ?? null;
    if (selection.name === 'additions') return record.additions ?? 0;
    if (selection.name === 'deletions') return record.deletions ?? 0;
    if (selection.name === 'changes') return record.changes ?? 0;
    return null;
  }

  if (parentType === 'IssueComment') {
    if (selection.name === 'id') {
      const repo = record.repo as Repo;
      const comment = record.comment as { id: number };
      return globalId('IssueComment', repo.id, record.issueNumber as number, comment.id);
    }
    if (selection.name === 'body') return (record.comment as { body: string }).body;
    if (selection.name === 'author') return sub(userValue(), 'User');
    if (selection.name === 'createdAt') return '2025-01-01T00:00:00Z';
    return null;
  }

  if (parentType === 'CommentEdge') {
    if (selection.name === 'node') {
      const node = record.node as GqlValue;
      return sub(node, (node as { __typename: string }).__typename);
    }
    if (selection.name === 'cursor') return '';
    return null;
  }

  if (parentType === '__Type') {
    const typeName = record.typeName as string;
    if (selection.name === 'name') return typeName;
    if (selection.name === 'kind') return typeKind(typeName);
    if (selection.name === 'description') return null;
    if (selection.name === 'fields') {
      const fields = (SCHEMA_FIELDS[typeName] ?? []).map((field) => ({ __typename: '__Field', name: field.name, description: field.description ?? null }));
      return fields.map((field) => sub(field, '__Field'));
    }
    if (selection.name === 'enumValues') {
      const values = (SCHEMA_ENUMS[typeName] ?? []).map((name) => ({ __typename: '__EnumValue', name, description: null }));
      return values.map((value) => sub(value, '__EnumValue'));
    }
    if (selection.name === 'inputFields') {
      const fields = (SCHEMA_INPUTS[typeName] ?? []).map((name) => ({ __typename: '__InputValue', name, description: null }));
      return fields.map((field) => sub(field, '__InputValue'));
    }
    return null;
  }

  if (parentType === '__Field') {
    if (selection.name === 'name') return record.name ?? null;
    if (selection.name === 'description') return record.description ?? null;
    if (selection.name === 'args') return [];
    if (selection.name === 'type') return sub({ __typename: '__Type', typeName: 'String' }, '__Type');
    return null;
  }

  if (parentType === '__EnumValue') {
    if (selection.name === 'name') return record.name ?? null;
    if (selection.name === 'description') return record.description ?? null;
    return null;
  }

  if (parentType === '__InputValue') {
    if (selection.name === 'name') return record.name ?? null;
    if (selection.name === 'description') return record.description ?? null;
    if (selection.name === 'type') return sub({ __typename: '__Type', typeName: 'String' }, '__Type');
    return null;
  }

  if (parentType === '__Schema') {
    if (selection.name === 'types') {
      const names = [...Object.keys(SCHEMA_FIELDS), ...Object.keys(SCHEMA_ENUMS), ...Object.keys(SCHEMA_INPUTS)];
      return names.map((name) => sub({ __typename: '__Type', typeName: name }, '__Type'));
    }
    if (selection.name === 'queryType') return sub({ __typename: '__Type', typeName: 'Query' }, '__Type');
    if (selection.name === 'mutationType') return sub({ __typename: '__Type', typeName: 'Mutation' }, '__Type');
    if (selection.name === 'description') return null;
    return null;
  }

  // Payload types: the field is the object itself.
  if (parentType.endsWith('Payload')) {
    const value = record[selection.name] as GqlValue | undefined;
    if (value === undefined) return null;
    const type = (value as { __typename: string }).__typename;
    return sub(value, type);
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function findRepoByGlobalId(ctx: ExecutorContext, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  return findRepoById(ctx.store, Number(decoded.parts[0]));
}

function findIssueByGlobalId(ctx: ExecutorContext, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
  const issue = repo?.issues.get(Number(decoded.parts[1]));
  return repo && issue ? { repo, issue } : null;
}

function findPullByGlobalId(ctx: ExecutorContext, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repo = findRepoById(ctx.store, Number(decoded.parts[0]));
  const pull = repo?.pulls.get(Number(decoded.parts[1]));
  return repo && pull ? { repo, pull } : null;
}

function resolveMutation(ctx: ExecutorContext, selection: Extract<SelectionNode, { kind: 'Field' }>, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const sub = (value: GqlValue | null, type: string): unknown => {
    if (value === null) return null;
    if (selection.selections.length === 0) return value;
    return executeSelections(ctx, type, value, selection.selections);
  };

  if (selection.name === 'createIssue') {
    const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'repository not found' });
      return sub(null, 'CreateIssuePayload');
    }
    const title = String(input.title ?? '');
    if (title === '') {
      ctx.errors.push({ message: 'title is required' });
      return sub(null, 'CreateIssuePayload');
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      id: ctx.store.nextObjectId(),
      number: repo.issueSeq,
      title,
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      seq: ctx.store.nextSeq(),
    };
    repo.issues.set(issue.number, issue);
    return sub({ __typename: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null }, 'CreateIssuePayload');
  }

  if (selection.name === 'closeIssue') {
    const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'issue not found' });
      return sub(null, 'CloseIssuePayload');
    }
    found.issue.state = 'closed';
    return sub({ __typename: 'CloseIssuePayload', issue: issueValue(found.repo, found.issue), clientMutationId: (input.clientMutationId as string | null) ?? null }, 'CloseIssuePayload');
  }

  if (selection.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
    if (!repo) {
      ctx.errors.push({ message: 'repository not found' });
      return sub(null, 'CreatePullRequestPayload');
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      ctx.errors.push({ message: 'head or base branch does not exist' });
      return sub(null, 'CreatePullRequestPayload');
    }
    repo.pullSeq += 1;
    const pull: Pull = {
      id: ctx.store.nextObjectId(),
      number: repo.pullSeq,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      head,
      base,
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
      seq: ctx.store.nextSeq(),
    };
    repo.pulls.set(pull.number, pull);
    return sub({ __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null }, 'CreatePullRequestPayload');
  }

  if (selection.name === 'mergePullRequest') {
    const found = findPullByGlobalId(ctx, String(input.pullRequestId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'pull request not found' });
      return sub(null, 'MergePullRequestPayload');
    }
    const { repo, pull } = found;
    if (pull.state !== 'open') {
      ctx.errors.push({ message: 'pull request is not open' });
      return sub({ __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null }, 'MergePullRequestPayload');
    }
    const merged = threeWayMerge(repo, pull);
    if (merged.conflict || merged.treeOid === null) {
      ctx.errors.push({ message: 'merge conflict' });
      return sub({ __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null }, 'MergePullRequestPayload');
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
    repo.commitSeq += 1;
    const commit = buildCommit({
      tree: merged.treeOid,
      parents: [baseTip],
      message: `${pull.title}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: REST_EPOCH_SEC + repo.commitSeq,
    });
    const commitSha = hashObject('commit', commit);
    if (!repo.objects.has(commitSha)) repo.objects.set(commitSha, { type: 'commit', data: commit });
    repo.refs.set(`refs/heads/${pull.base}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2025-01-01T00:00:00Z';
    pull.mergeCommitSha = commitSha;
    return sub({ __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null }, 'MergePullRequestPayload');
  }

  if (selection.name === 'addComment') {
    const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
    if (!found) {
      ctx.errors.push({ message: 'subject not found' });
      return sub(null, 'AddCommentPayload');
    }
    const { repo, issue } = found;
    repo.commentSeq += 1;
    const comment = { id: ctx.store.nextObjectId(), body: String(input.body ?? ''), seq: ctx.store.nextSeq() };
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    const node = { __typename: 'IssueComment', repo, issueNumber: issue.number, comment };
    return sub(
      {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node },
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      },
      'AddCommentPayload',
    );
  }

  ctx.errors.push({ message: `unknown mutation ${selection.name}` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// validation + entry point
// ---------------------------------------------------------------------------------------------

/** Validate field names against the schema; returns error messages (empty when valid). */
function validateSelections(selections: SelectionNode[], parentType: string, fragments: Map<string, FragmentNode>, errors: string[]): void {
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment) validateSelections(fragment.selections, fragment.typeCondition, fragments, errors);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      validateSelections(selection.selections, selection.typeCondition ?? parentType, fragments, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    const known = fieldNamesOf(parentType);
    if (!known.includes(selection.name)) {
      errors.push(`Cannot query field "${selection.name}" on type "${parentType}".`);
      continue;
    }
    const childType = childTypeOf(parentType, selection.name);
    if (childType !== null && selection.selections.length > 0) {
      validateSelections(selection.selections, childType, fragments, errors);
    }
  }
}

/** The object type a field's sub-selections belong to (null for scalars / unknown). */
function childTypeOf(parentType: string, field: string): string | null {
  if (parentType === 'Query') {
    if (field === 'viewer') return 'User';
    if (field === 'repository') return 'Repository';
    if (field === 'node') return 'Node';
    if (field === '__type') return '__Type';
    if (field === '__schema') return '__Schema';
    return null;
  }
  if (parentType === 'Mutation') {
    if (field === 'createIssue') return 'CreateIssuePayload';
    if (field === 'closeIssue') return 'CloseIssuePayload';
    if (field === 'createPullRequest') return 'CreatePullRequestPayload';
    if (field === 'mergePullRequest') return 'MergePullRequestPayload';
    if (field === 'addComment') return 'AddCommentPayload';
    return null;
  }
  if (parentType === 'Node') return 'Node';
  switch (field) {
    case 'owner':
    case 'author':
      return 'User';
    case 'defaultBranchRef':
    case 'headRef':
    case 'baseRef':
      return 'Ref';
    case 'issue':
      return 'Issue';
    case 'issues':
      return 'IssueConnection';
    case 'pullRequest':
      return 'PullRequest';
    case 'pullRequests':
      return 'PullRequestConnection';
    case 'files':
      return 'PullRequestConnection';
    case 'nodes':
      return parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequestConnectionNode' : null;
    case 'edges':
      return parentType === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge';
    case 'node':
      return parentType === 'IssueEdge' ? 'Issue' : parentType === 'PullRequestEdge' ? 'PullRequestConnectionNode' : parentType === 'CommentEdge' ? 'IssueComment' : 'Node';
    case 'pageInfo':
      return 'PageInfo';
    case 'fields':
      return '__Field';
    case 'enumValues':
      return '__EnumValue';
    case 'inputFields':
      return '__InputValue';
    case 'types':
    case 'queryType':
    case 'mutationType':
      return '__Type';
    case 'type':
      return '__Type';
    case 'args':
      return '__InputValue';
    case 'repository':
      return 'Repository';
    case 'commentEdge':
      return 'CommentEdge';
    case 'comments':
      return 'IssueConnection';
    case 'pullRequest':
      return 'PullRequest';
    default:
      return null;
  }
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

/** Execute one operation document. `variables` defaults to {}. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>, operationName?: string | null): GraphQLResult {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName) {
    operation = parsed.operations.find((op) => op.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `unknown operation ${operationName}` }] };
  } else if (parsed.operations.length === 1) {
    operation = parsed.operations[0];
  } else if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in document' }] };
  } else {
    return { data: null, errors: [{ message: 'must provide operation name for multiple operations' }] };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: string[] = [];
  validateSelections(operation.selections, rootType, parsed.fragments, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const ctx: ExecutorContext = { store, variables, fragments: parsed.fragments, errors: [] };
  const data = executeSelections(ctx, rootType, { __typename: rootType }, operation.selections);
  const errors = ctx.errors.map((error) => ({ message: error.message }));
  return { data, errors };
}
