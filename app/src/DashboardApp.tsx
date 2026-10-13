import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { ProjectView } from "./ProjectView";
import { parseProjectRoute, type ProjectRoute } from "./nav";

type Route = { name: "dashboard" } | ({ name: "project" } & ProjectRoute);

function parseRoute(hash: string): Route {
  const project = parseProjectRoute(hash);
  return project ? { name: "project", ...project } : { name: "dashboard" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

export function DashboardApp() {
  const route = useHashRoute();

  if (route.name === "project") {
    return (
      <ProjectView
        projectId={route.id}
        tab={route.tab}
        params={route.params}
        onBack={() => {
          window.location.hash = "#/";
        }}
      />
    );
  }

  return <Dashboard />;
}
