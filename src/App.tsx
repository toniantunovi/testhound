import { useEffect, useState } from "react";
import { api } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { Onboarding } from "@/screens/Onboarding";
import { AppShell } from "@/components/shell/AppShell";

export default function App() {
  const project = useSession((s) => s.project);
  const setProject = useSession((s) => s.setProject);
  const [checked, setChecked] = useState(false);

  // Restore an already-open project (e.g. after a hot reload during dev).
  useEffect(() => {
    api
      .currentProject()
      .then((p) => p && setProject(p))
      .catch(() => {})
      .finally(() => setChecked(true));
  }, [setProject]);

  if (!checked) {
    return <div className="h-full bg-bg-base" />;
  }

  if (!project) {
    return <Onboarding onReady={setProject} />;
  }

  return <AppShell />;
}
