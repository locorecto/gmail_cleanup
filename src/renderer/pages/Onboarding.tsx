import { useState } from "react";
import type { ConnectedAccount } from "@shared/types";
import { useInvoke } from "../hooks/useIpc";

export default function Onboarding({
  onConnected,
}: {
  onConnected: (acct: ConnectedAccount) => void;
}) {
  const invoke = useInvoke();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setLoading(true);
    setError(null);
    try {
      const acct = await invoke<ConnectedAccount>("auth:connect");
      onConnected(acct);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen gap-6 px-8 max-w-md mx-auto text-center">
      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Gmail Cleanup</h1>
        <p className="text-gray-400 text-sm leading-relaxed">
          Connect your Gmail account to scan, categorize, and safely batch-delete
          emails you'll never read again. Nothing is permanently deleted — everything
          goes to Trash first.
        </p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-left w-full text-sm text-gray-400">
        <p className="font-medium text-gray-300 mb-2">What this app will access:</p>
        <ul className="space-y-1">
          <li>✓ Read your email metadata (senders, subjects, dates)</li>
          <li>✓ Move emails to Trash (recoverable for 30 days)</li>
          <li className="text-red-400">✗ Cannot permanently delete anything</li>
          <li className="text-red-400">✗ Cannot send emails or modify contacts</li>
        </ul>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded px-4 py-2 text-red-400 text-sm w-full">
          {error}
        </div>
      )}

      <button
        onClick={connect}
        disabled={loading}
        className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-medium py-2 px-6 rounded-lg transition-colors w-full"
      >
        {loading ? "Opening browser…" : "Connect Gmail Account"}
      </button>

      <p className="text-xs text-gray-600">
        Google will show an "unverified app" warning — this is expected for a personal
        app. Click "Advanced → Go to Gmail Cleanup (unsafe)" to proceed.
      </p>
    </div>
  );
}
