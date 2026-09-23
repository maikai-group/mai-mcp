// App shell: providers, sidebar, hash-synced destination routing, live review
// badge, and the note modal host. Views for Search/Timeline/Sessions/Topics
// (Task 5), Review (Task 6) and Graph (Task 7) land as those tasks complete;
// until then they render a placeholder.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';
import { ToastProvider } from './toast';
import { SettingsProvider } from './settings';
import { ProjectProvider, useProjects } from './project';
import { Nav } from './Nav';
import { NoteModal } from './NoteModal';
import { isDestination, DESTINATION_LABELS, type Destination } from './destinations';
import { Home } from '../views/home/Home';
import { Review } from '../views/review/Review';
import { Graph } from '../views/graph/Graph';
import { Search } from '../views/search/Search';
import { Timeline } from '../views/timeline/Timeline';
import { Sessions } from '../views/sessions/Sessions';
import { Topics } from '../views/topics/Topics';
import { Roadmap } from '../views/roadmap/Roadmap';
import { MyTasks } from '../views/tasks/MyTasks';
import { Sharing } from '../views/sharing/Sharing';
import { Providers } from '../views/settings/Providers';
import { Profile } from '../views/profile/Profile';
import type { ReviewRow, UserTaskListResponse } from '../lib/types';

const BADGE_POLL_MS = 60_000;

function initialDestination(): Destination {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return isDestination(h) ? h : 'home';
}

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center text-ink-faint">
      {name} — coming soon
    </div>
  );
}

function ShellInner() {
  const { project } = useProjects();
  const [dest, setDest] = useState<Destination>(initialDestination);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [taskBadge, setTaskBadge] = useState<{ project: string; count: number } | null>(null);
  const taskBadgeGeneration = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [noteOpen, setNoteOpen] = useState(false);

  // Hash ↔ state sync (no router dep).
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace(/^#\/?/, '').split('?')[0];
      if (isDestination(h)) setDest(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((d: Destination) => {
    setDest(d);
    window.location.hash = `/${d}`;
  }, []);

  // Live review badge — poll the JSON queue and count rows. (limit high enough
  // to render an accurate count; capped display at 99+.) Exposed so the Review
  // view can refresh it immediately after approve/deny.
  const pollBadge = useCallback(() => {
    if (!project) return;
    apiGet<{ rows: ReviewRow[] }>('/review', { format: 'json', limit: 100 })
      .then((r) => setReviewCount(r.rows.length))
      .catch(() => setReviewCount(null));
  }, [project]);

  useEffect(() => {
    if (!project) return;
    pollBadge();
    const id = window.setInterval(pollBadge, BADGE_POLL_MS);
    return () => window.clearInterval(id);
  }, [project, pollBadge]);

  const pollTaskBadge = useCallback(() => {
    const requestProject = project;
    if (!requestProject || projectRef.current !== requestProject) return;
    const generation = ++taskBadgeGeneration.current;
    apiGet<UserTaskListResponse>('/user-tasks', { summary: 1 })
      .then((response) => {
        if (taskBadgeGeneration.current === generation && projectRef.current === requestProject) {
          setTaskBadge({ project: requestProject, count: response.pending_count });
        }
      })
      .catch(() => {
        if (taskBadgeGeneration.current === generation && projectRef.current === requestProject) {
          setTaskBadge(null);
        }
      });
  }, [project]);

  useEffect(() => {
    taskBadgeGeneration.current += 1;
    setTaskBadge(null);
    if (!project) return;
    pollTaskBadge();
    const id = window.setInterval(pollTaskBadge, BADGE_POLL_MS);
    return () => {
      window.clearInterval(id);
      taskBadgeGeneration.current += 1;
    };
  }, [project, pollTaskBadge]);

  const visibleTaskCount = taskBadge?.project === project ? taskBadge.count : null;

  const view = (() => {
    switch (dest) {
      case 'home':
        return <Home onNavigate={navigate} reviewCount={reviewCount} />;
      case 'review':
        return <Review onQueueChanged={pollBadge} />;
      case 'roadmap':
        return <Roadmap />;
      case 'tasks':
        return <MyTasks onTasksChanged={pollTaskBadge} />;
      case 'sharing':
        return <Sharing />;
      case 'graph':
        return <Graph />;
      case 'search':
        return <Search />;
      case 'timeline':
        return <Timeline />;
      case 'sessions':
        return <Sessions />;
      case 'topics':
        return <Topics />;
      case 'settings':
        return <Providers />;
      case 'profile':
        return <Profile onNavigate={navigate} />;
      default:
        return <Placeholder name={DESTINATION_LABELS[dest]} />;
    }
  })();

  return (
    <div className="flex h-full w-full bg-deep-950">
      <Nav active={dest} onNavigate={navigate} reviewCount={reviewCount} taskCount={visibleTaskCount}
        onNewNote={() => setNoteOpen(true)} />
      <main className="h-full flex-1 overflow-y-auto">
        <div key={dest} className="h-full animate-[viewin_200ms_ease-out]">
          {view}
        </div>
      </main>
      {noteOpen && <NoteModal onClose={() => setNoteOpen(false)} />}
    </div>
  );
}

export function Shell() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <ProjectProvider>
          <ShellInner />
        </ProjectProvider>
      </SettingsProvider>
    </ToastProvider>
  );
}
