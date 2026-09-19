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
