// Project selector — a native select styled to the shell. Sits at the top of
// the sidebar; every API call reads the selection from the api client.
import { useProjects } from './project';

export function ProjectSwitcher() {
  const { project, projects, setProject } = useProjects();
  return (
    <label className="block">
      <span className="mb-1 block text-[0.65rem] font-medium uppercase tracking-wider text-ink-faint">
        Project
      </span>
      <select
        value={project}
        onChange={(e) => setProject(e.target.value)}
        className="w-full rounded-md border border-deep-700 bg-deep-950 px-2.5 py-1.5 font-mono text-sm text-ink outline-none transition-colors focus:border-flow-400"
      >
        {projects.length === 0 && <option value="">—</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
