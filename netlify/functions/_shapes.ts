// _shapes.ts — Shared request/response shapes for SAM's serverless API.
//
// This file is the server-side source of truth for every endpoint's
// contract. It mirrors the typed methods in public/js/api.js so schema
// drift between client and server becomes a single-file edit instead of
// a cross-file archaeology problem.
//
// Phase 1 migration plan:
//   - Each *.mts function imports its request/response types from here.
//   - Each callsite in public/js/api.js mirrors the same names via JSDoc.
//   - New endpoints MUST add their shape here before shipping.
//   - Changes to existing shapes MUST update all three: _shapes.ts, the
//     function, and the client.
//
// Keeping it dependency-free so it can be imported from any .mts file
// without introducing a build-graph concern.

// ──────────────────────────────────────────────────────────────────────────
// COMMON
// ──────────────────────────────────────────────────────────────────────────

export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type TaskStatus = 'todo' | 'in-progress' | 'done' | 'canceled' | 'review' | 'archived';
export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type InstructionCategory =
  | 'identity' | 'preferences' | 'clients' | 'rules'
  | 'knowledge' | 'contacts' | 'schedule' | 'custom';
export type EmailProvider = 'm365' | 'gmail' | 'yahoo';
export type AIModel = 'claude' | 'openai' | 'gemini' | 'council' | 'grok';

export interface ApiError {
  error: string;
  detail?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// EMAIL
// ──────────────────────────────────────────────────────────────────────────

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailRecipient {
  emailAddress: EmailAddress;
}

export interface EmailSummary {
  id: string;
  subject: string;
  from: EmailRecipient;
  receivedDateTime: string;
  isRead: boolean;
  bodyPreview: string;
  isFlagged?: boolean;
}

export interface EmailBody extends EmailSummary {
  body: { contentType: 'HTML' | 'Text' | 'html'; content: string };
  toRecipients?: EmailRecipient[];
  ccRecipients?: EmailRecipient[];
}

export interface EmailListResponse {
  value: EmailSummary[];
}

export interface EmailSendRequest {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  content: string;
  contentType?: 'HTML' | 'text';
}

export interface EmailSendResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// CALENDAR
// ──────────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone?: string };
  end:   { dateTime: string; timeZone?: string };
  location?: { displayName?: string } | string;
  attendees?: { emailAddress: EmailAddress }[];
  isAllDay?: boolean;
  _src?: 'M365' | 'Google';
}

export interface CalendarListResponse {
  value: CalendarEvent[];
}

// ──────────────────────────────────────────────────────────────────────────
// TASKS
// ──────────────────────────────────────────────────────────────────────────

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
  status: TaskStatus;
  category?: string;
  dueDate?: string;
  notes?: string;
  subtasks?: Subtask[];
  createdAt?: string;
  updatedAt?: string;
  // Phase-5 recurrence extension (optional for back-compat).
  recurrence?: TaskRecurrence;
  parentId?: string; // Materialized instance → recurring parent.
}

export interface TaskRecurrence {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byDay?: ('MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU')[];
  dayOfMonth?: number;
  until?: string;
  count?: number;
}

export interface TaskListResponse {
  tasks: Task[];
}

// ──────────────────────────────────────────────────────────────────────────
// PROJECTS
// ──────────────────────────────────────────────────────────────────────────

export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  type?: string;
  createdAt?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  category?: string;
  status: ProjectStatus;
  priority?: Priority;
  systemPrompt?: string;
  tags?: string[];
  notes?: string;
  knowledge?: KnowledgeItem[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface ProjectContextResponse {
  context: string;
  tokenEstimate?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// INSTRUCTIONS (PERMANENT MEMORY)
// ──────────────────────────────────────────────────────────────────────────

export interface Instruction {
  id: string;
  title: string;
  content: string;
  category: InstructionCategory;
  enabled: boolean;
  order?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface InstructionStats {
  total: number;
  enabled: number;
  disabled: number;
  charCount: number;
  tokenEstimate: number;
}

export interface InstructionListResponse {
  instructions: Instruction[];
  stats: InstructionStats;
}

// ──────────────────────────────────────────────────────────────────────────
// AI
// ──────────────────────────────────────────────────────────────────────────

export interface AIRequest {
  model: AIModel;
  prompt: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
  systemPrompt?: string;
}

export interface AIResponse {
  reply: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  // Council-only fields.
  individual?: { model: string; reply: string; tokensIn?: number; tokensOut?: number }[];
  modelsUsed?: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// ZOOM
// ──────────────────────────────────────────────────────────────────────────

export interface ZoomMeeting {
  id: string | number;
  uuid?: string;
  topic: string;
  type?: number;
  start_time?: string;
  duration?: number;
  timezone?: string;
  join_url?: string;
  password?: string;
  host_email?: string;
}

export interface ZoomMeetingsResponse {
  meetings: ZoomMeeting[];
}

export interface ZoomRecording {
  uuid: string;
  topic: string;
  start_time: string;
  duration: number;
  recording_files?: { id: string; file_type: string; download_url: string; status: string }[];
}

export interface ZoomRecordingsResponse {
  recordings: ZoomRecording[];
}

// ──────────────────────────────────────────────────────────────────────────
// FLAGS
// ──────────────────────────────────────────────────────────────────────────

export interface EmailFlag {
  id: string;
  acct: EmailProvider;
  createdAt: string;
  note?: string;
}

export interface FlagListResponse {
  flags: EmailFlag[];
}

// ──────────────────────────────────────────────────────────────────────────
// BOOKING
// ──────────────────────────────────────────────────────────────────────────

export interface BookingRequest {
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  notes?: string;
  type: string;
  duration: number;
  startDateTime: string;
  endDateTime: string;
  timeZone?: string;
  platform?: 'zoom' | 'meet' | 'teams' | 'phone';
}

export interface BookingResponse {
  success: boolean;
  partial?: boolean;
  message?: string;
  bookingId?: string;
  results: {
    zoom?: { ok: boolean; id?: string | number; join_url?: string; error?: string };
    m365?: { ok: boolean; id?: string; error?: string };
    gcal?: { ok: boolean; id?: string; error?: string };
    task?: { ok: boolean; id?: string; error?: string };
    email?: { ok: boolean; clientSent?: boolean; adminSent?: boolean; error?: string };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// BACKUP
// ──────────────────────────────────────────────────────────────────────────

export interface BackupStatus {
  lastBackup?: {
    timestamp: string;
    sizeKB: number;
    stores: number;
    elapsed: string;
    commit?: string;
  };
}

export interface BackupRunResponse {
  success: boolean;
  sizeKB?: number;
  commit?: string;
  error?: string;
  stores?: Record<string, { ok: boolean; bytes?: number; error?: string }>;
}

// ──────────────────────────────────────────────────────────────────────────
// BRIEFING (Phase 1.1 Morning Briefing Engine)
// ──────────────────────────────────────────────────────────────────────────

export interface BriefingSources {
  m365Inbox: string;
  gmail: string;
  calendar: string;
  tasks: string;
  transcripts: string;
}

export interface BriefingArchive {
  date: string;              // YYYY-MM-DD in America/New_York
  dateLabel: string;         // "Thursday, April 23, 2026"
  generatedAt: string;       // ISO timestamp
  briefing: string;          // Synthesized markdown
  sources: BriefingSources;  // Raw inputs captured at generation time
  durationMs: number;
}

export interface BriefingRunResponse {
  ok: true;
  key: string;       // Date key of the archive written
  preview: string;   // First 300 chars of the briefing
  durationMs: number;
}

export interface BriefingHistoryResponse {
  dates: string[];   // Up to 30 most recent YYYY-MM-DD keys, newest first
  count: number;     // Total archives in the store
}
