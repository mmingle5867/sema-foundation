export type RecordStatus = 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
export type InstallationStatus = 'DISCOVERED' | 'INSTALLED' | 'ACTIVE' | 'DISABLED' | 'REMOVED';

export type User = { id: string; displayName: string; email?: string; status: RecordStatus; createdAt: string };
/**
 * serviceApproval: approval before first use (D-192). When on, a service version runs for this organization only once an
 * administrator has approved it here. Off unless turned on, so developers can publish services without being blocked. A
 * workspace may turn it on for itself, never off when its organization has it on.
 */
export type Organization = { id: string; displayName: string; status: RecordStatus; createdAt: string; serviceApproval?: boolean };
export type Workspace = { id: string; organizationId: string; displayName: string; kind: string; status: RecordStatus; createdAt: string; serviceApproval?: boolean };
export type Membership = { id: string; userId: string; organizationId: string; workspaceId?: string; roleKeys: string[]; status: RecordStatus; createdAt: string };
export type RoleDefinition = { id: string; key: string; displayName: string; description?: string; scopeKind: 'ORGANIZATION' | 'WORKSPACE'; status: RecordStatus; createdAt: string };
export type AccessGroup = { id: string; organizationId: string; workspaceId?: string; displayName: string; description?: string; status: RecordStatus; createdAt: string };
export type GroupMembership = { id: string; groupId: string; userId: string; status: RecordStatus; createdAt: string };
export type Delegation = { id: string; delegatorUserId: string; delegateUserId: string; organizationId: string; workspaceId?: string; applicationKey?: string; operations: string[]; effectiveAt: string; expiresAt: string; revokedAt?: string; note?: string; createdAt: string };
export type StorageLocation = { id: string; organizationId: string; workspaceId?: string; displayName: string; rootUri: string; status: RecordStatus; createdAt: string };

/**
 * The name of a node in SEMA Core's tree. Core holds the node itself (ID, type, parent); this is only what people
 * call it, with a note. An organization or a user record with the same ID is already that node's description, so a
 * node description is kept only for nodes that have neither, such as sites, machines and groups of people.
 */
export type NodeDescription = { nodeId: string; displayName: string; note?: string; updatedAt: string };

/**
 * An organization's choices for a capability (D-190 to D-195), optionally for one job of Ask an AI and optionally for one
 * workspace. services is an ordered list, both which services are allowed and the order they are tried; an entry is a
 * service key (its usable versions, newest first) or key@version. No list: every service allowed. way is the default
 * way of choosing for a command that names none. A workspace only narrows: every list that applies must allow a service.
 */
export type ChoosingWay = 'bound' | 'dynamic' | 'consensus';
export type CapabilityChoice = { organizationId: string; workspaceId?: string; capabilityKey: string; jobKey?: string; services?: string[]; way?: ChoosingWay; updatedAt: string };
/** An administrator's approval of one service version for an organization (D-191). It never covers a newer version. */
export type ServiceApproval = { id: string; organizationId: string; serviceVersionId: string; serviceKey: string; version: string; approvedAt: string; revokedAt?: string };
/** What Core gets with a "may" answer for a capability: the lists that apply, most specific first, and the approvals. */
export type OrganizationChoices = { lists: string[][]; way?: ChoosingWay; approvalRequired: boolean; approved: string[] };

export type ApplicationDefinition = {
  id: string; applicationKey: string; displayName: string; vendor?: string; version: string;
  description?: string; manifest: Record<string, unknown>; status: RecordStatus; createdAt: string; updatedAt: string;
  /**
   * Set for an application built outside SEMA, to be brought in later (D-177). Each installation of it gets its own
   * basis, a fresh ID from Core, and issues its own IDs as basis-3, basis-4 and so on, so no two installations and
   * nothing in SEMA can issue the same ID. The application's own ID is its identity, never a basis.
   */
  outside?: { bases: ApplicationBasis[] };
};
export type ApplicationBasis = { id: string; label: string; issuedAt: string };
export type ApplicationInstallation = {
  id: string; applicationId: string; displayName: string; version: string; hostLabel?: string;
  locationHint?: string; status: InstallationStatus; installedAt: string; updatedAt: string;
};
export type CatalogRelease = {
  id: string; capabilityKey: string; providerKey: string; serviceKey: string; version: string;
  displayName: string; packageUri?: string; packageHash?: string; manifest: Record<string, unknown>;
  trustStatus: 'UNVERIFIED' | 'VERIFIED' | 'REJECTED'; status: InstallationStatus; createdAt: string; updatedAt: string;
};

export type AccessGrant = {
  id: string; granteeKind: 'USER' | 'APPLICATION' | 'GROUP'; granteeId: string; operations: string[];
  organizationId?: string; workspaceId?: string; applicationKey?: string; issuedByUserId?: string;
  expiresAt?: string; revokedAt?: string; createdAt: string;
};
export type TestingNoteStatus = 'OPEN' | 'DEFERRED' | 'REJECTED' | 'SELECTED' | 'IMPLEMENTED';
export type TestingNote = {
  id: string; applicationId?: string; applicationKey?: string; applicationVersion?: string;
  subjectKind: 'APPLICATION' | 'CAPABILITY' | 'SERVICE' | 'CORE' | 'SYSTEM_CONSOLE'; subjectId: string; subjectLabel: string; subjectVersion?: string;
  kind: 'TEST_NOTE' | 'DEFECT' | 'CHANGE_REQUEST' | 'QUESTION'; priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  title: string; detail: string; status: TestingNoteStatus; selectedForPacket: boolean; createdAt: string; updatedAt: string;
  history: Array<{ at: string; action: string; detail?: string }>;
};
export type ChangePacket = { id: string; applicationId?: string; applicationKey?: string; subjectKind: TestingNote['subjectKind']; subjectId: string; subjectLabel: string; subjectVersion?: string; createdAt: string; noteIds: string[]; summary: string; status: 'DRAFT' | 'SENT_TO_AI' | 'IMPLEMENTED' | 'CANCELLED' };

/** Authentication secrets are intentionally kept out of the administrative index. */
export type UserCredential = {
  userId: string;
  emailNormalized: string;
  passwordHash: string;
  passwordSalt: string;
  passwordChangedAt: string;
  failedLoginCount: number;
  lockedUntil?: string;
};

/** Sessions are intentionally ephemeral and receive random, non-SEMA identifiers. */
export type AuthSession = {
  id: string;
  userId: string;
  workspaceId?: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
};

export type AuthState = {
  version: 1;
  credentials: UserCredential[];
  sessions: AuthSession[];
};

export type AccessIndex = {
  version: 1;
  bootstrappedAt?: string;
  users: User[]; organizations: Organization[]; workspaces: Workspace[]; memberships: Membership[]; roleDefinitions: RoleDefinition[]; groups: AccessGroup[]; groupMemberships: GroupMembership[]; delegations: Delegation[];
  storageLocations: StorageLocation[]; nodeDescriptions: NodeDescription[]; applications: ApplicationDefinition[];
  installations: ApplicationInstallation[]; catalogReleases: CatalogRelease[]; grants: AccessGrant[]; testingNotes: TestingNote[]; changePackets: ChangePacket[];
  capabilityChoices: CapabilityChoice[]; serviceApprovals: ServiceApproval[];
};

export const blankIndex = (): AccessIndex => ({ version: 1, users: [], organizations: [], workspaces: [], memberships: [], roleDefinitions: [], groups: [], groupMemberships: [], delegations: [], storageLocations: [], nodeDescriptions: [], applications: [], installations: [], catalogReleases: [], grants: [], testingNotes: [], changePackets: [], capabilityChoices: [], serviceApprovals: [] });
export const blankAuthState = (): AuthState => ({ version: 1, credentials: [], sessions: [] });
