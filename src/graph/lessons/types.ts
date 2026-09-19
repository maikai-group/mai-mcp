export interface LessonAdvice {
  id: string;
  rule: string;
  context: string | null;
  why: string | null;
  how_to_apply: string | null;
  confidence: number;
  confidence_label: string;
  scope: 'project' | 'global';
  source_session_id: string | null;
}
export interface AttachedLesson extends LessonAdvice {
  attachment_id: string;
  attached_at: string;
  note: string;
}
export interface NodeLessons {
  node_id: string;
  identity: string;
  attached: AttachedLesson[];
  attached_total: number;
  offset: number;
}
export interface AttachmentInput {
  action: 'attach' | 'detach';
  node_id: string;
  lesson_id: string;
  reason: string;
}
export interface AgentAttachmentInput extends AttachmentInput {
  citation: { kind: 'extends'; extends_id: string; how: string };
}
export interface AttachmentResult {
  attachment_id: string;
  state: 'attached' | 'detached';
  changed: boolean;
}
