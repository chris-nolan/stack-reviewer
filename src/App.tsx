import { NavProvider, useNav } from "./app/nav";
import { useSession } from "./app/session";
import { CommandsProvider } from "./app/commands";
import { Palette } from "./app/Palette";
import { Notifier } from "./app/Notifier";
import { SeenRecorder } from "./app/Seen";
import { Home } from "./features/Home";
import { Overview } from "./features/Overview";
import { Review } from "./features/review/Review";
import { Settings } from "./features/Settings";
import { SignIn } from "./features/SignIn";
import { Spinner } from "./ui/bits";

function Routes() {
  const { route } = useNav();
  switch (route.name) {
    case "home":
      return <Home />;
    case "settings":
      return <Settings />;
    case "overview":
      return <Overview repo={route.repo} stackKey={route.stackKey} />;
    case "review":
      return <Review repo={route.repo} stackKey={route.stackKey} layer={route.layer} file={route.file} line={route.line} />;
  }
}

export default function App() {
  const { status } = useSession();
  if (status === "loading") return <div style={{ height: "100%", display: "grid", placeItems: "center" }}><Spinner label="Starting…" /></div>;
  if (status === "signed-out") return <SignIn />;
  return (
    <NavProvider>
      <CommandsProvider>
        <Notifier />
        <SeenRecorder />
        <Routes />
        <Palette />
      </CommandsProvider>
    </NavProvider>
  );
}
