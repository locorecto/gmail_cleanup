import { useState, useEffect, useCallback } from "react";
import type { ConnectedAccount } from "@shared/types";
import { useInvoke } from "./hooks/useIpc";
import Dashboard from "./pages/Dashboard";
import CategoryReview from "./pages/CategoryReview";
import ActionLog from "./pages/ActionLog";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";

type Page =
  | { name: "onboarding" }
  | { name: "dashboard" }
  | { name: "category"; id: string }
  | { name: "actionlog" }
  | { name: "settings" };

export default function App() {
  const invoke = useInvoke();
  const [account, setAccount] = useState<ConnectedAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>({ name: "onboarding" });

  useEffect(() => {
    invoke<ConnectedAccount | null>("auth:status").then((acct) => {
      setAccount(acct);
      if (acct) setPage({ name: "dashboard" });
      setLoading(false);
    });
  }, [invoke]);

  const handleConnected = useCallback((acct: ConnectedAccount) => {
    setAccount(acct);
    setPage({ name: "dashboard" });
  }, []);

  const handleDisconnect = useCallback(async () => {
    await invoke("auth:disconnect");
    setAccount(null);
    setPage({ name: "onboarding" });
  }, [invoke]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-gray-400 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {account && (
        <Sidebar
          account={account}
          page={page}
          onNavigate={setPage}
          onDisconnect={handleDisconnect}
        />
      )}
      <main className="flex-1 overflow-auto">
        {page.name === "onboarding" && (
          <Onboarding onConnected={handleConnected} />
        )}
        {page.name === "dashboard" && account && (
          <Dashboard
            account={account}
            onOpenCategory={(id) => setPage({ name: "category", id })}
            onSynced={(acct) => setAccount(acct)}
          />
        )}
        {page.name === "category" && (
          <CategoryReview
            categoryId={page.id}
            onBack={() => setPage({ name: "dashboard" })}
          />
        )}
        {page.name === "actionlog" && (
          <ActionLog onBack={() => setPage({ name: "dashboard" })} />
        )}
        {page.name === "settings" && (
          <Settings onBack={() => setPage({ name: "dashboard" })} />
        )}
      </main>
    </div>
  );
}

function Sidebar({
  account,
  page,
  onNavigate,
  onDisconnect,
}: {
  account: ConnectedAccount;
  page: Page;
  onNavigate: (p: Page) => void;
  onDisconnect: () => void;
}) {
  const navItem = (label: string, target: Page) => {
    const active = page.name === target.name;
    return (
      <button
        onClick={() => onNavigate(target)}
        className={`w-full text-left px-4 py-2 rounded text-sm transition-colors ${
          active
            ? "bg-blue-600 text-white"
            : "text-gray-400 hover:bg-gray-800 hover:text-white"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <aside className="w-48 bg-gray-900 border-r border-gray-800 flex flex-col py-4 px-2 shrink-0">
      <div className="px-2 mb-6">
        <div className="text-xs font-bold text-white tracking-wide">Gmail Cleanup</div>
        <div className="text-xs text-gray-500 truncate mt-1">{account.email}</div>
      </div>
      <nav className="flex flex-col gap-1 flex-1">
        {navItem("Dashboard", { name: "dashboard" })}
        {navItem("Action Log", { name: "actionlog" })}
        {navItem("Settings", { name: "settings" })}
      </nav>
      <button
        onClick={onDisconnect}
        className="mx-2 text-xs text-gray-500 hover:text-red-400 transition-colors text-left"
      >
        Disconnect
      </button>
    </aside>
  );
}
