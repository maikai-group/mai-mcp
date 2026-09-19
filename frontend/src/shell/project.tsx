// Selected-project context. The api client holds the canonical current slug
// (localStorage-backed); this context mirrors it into React state so views
// re-render on switch, and calls api.setProject on change.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiGet, getProject, setProject as apiSetProject } from '../lib/api';
import type { ProjectRow } from '../lib/types';

interface ProjectApi {
  project: string;
  projects: ProjectRow[];
  setProject: (slug: string) => void;
}

const ProjectContext = createContext<ProjectApi | null>(null);

export function useProjects(): ProjectApi {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjects must be used within <ProjectProvider>');
  return ctx;
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProjectState] = useState<string>(getProject());
  const [projects, setProjects] = useState<ProjectRow[]>([]);

  useEffect(() => {
    let live = true;
    apiGet<{ projects: ProjectRow[] }>('/projects')
      .then((r) => {
        if (!live) return;
        setProjects(r.projects);
        // Default to the most-recently-active project when nothing is pinned.
        if (!getProject() && r.projects.length > 0) {
          apiSetProject(r.projects[0].slug);
          setProjectState(r.projects[0].slug);
        }
      })
      .catch(() => { /* offline / no token — selector stays empty */ });
    return () => { live = false; };
  }, []);

  const setProject = useCallback((slug: string) => {
    apiSetProject(slug);
    setProjectState(slug);
  }, []);

  const api = useMemo(() => ({ project, projects, setProject }), [project, projects, setProject]);
  return <ProjectContext.Provider value={api}>{children}</ProjectContext.Provider>;
}
