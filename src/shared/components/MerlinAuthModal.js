"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

export default function MerlinAuthModal({ isOpen, onSuccess, onClose }) {
  const [sessionToken, setSessionToken] = useState("");
  const [firebaseApiKey, setFirebaseApiKey] = useState("");
  const [name, setName] = useState("Merlin Session");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);

  const handleImportToken = async () => {
    if (!sessionToken.trim()) {
      setError("Please paste the Merlin session JSON");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/merlin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken: sessionToken.trim(),
          firebaseApiKey: firebaseApiKey.trim() || undefined,
          name: name.trim() || "Merlin Session",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Connect Merlin AI" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
          <div className="flex gap-2">
            <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
            <div className="text-sm text-blue-800 dark:text-blue-200 space-y-2">
              <p>Merlin does not provide a public OAuth API. 9Router imports your Merlin session once and refreshes it automatically when the JSON includes a refreshToken.</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Sign in at getmerlin.in.</li>
                <li>Open session.getmerlin.in/?from=web in the same browser.</li>
                <li>Paste the full JSON response below, not just the access token.</li>
                <li>Optional: paste the Firebase API key from DevTools → Application → IndexedDB → firebaseLocalStorageDb → firebaseLocalStorage → value.apiKey.</li>
              </ol>
            </div>
          </div>
        </div>

        <Input
          label="Connection Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Merlin Session"
        />

        <div>
          <label className="block text-sm font-medium mb-2">
            Full Session JSON <span className="text-red-500">*</span>
          </label>
          <textarea
            value={sessionToken}
            onChange={(e) => setSessionToken(e.target.value)}
            placeholder='Paste JSON like {"user":{"accessToken":"...","refreshToken":"...","expiresAt":1782721752,"email":"..."}}'
            rows={5}
            className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Auto-refresh requires the refreshToken from the full session JSON. Access-token-only imports still work, but expire.
          </p>
        </div>

        <Input
          label="Firebase API Key (optional)"
          value={firebaseApiKey}
          onChange={(e) => setFirebaseApiKey(e.target.value)}
          placeholder="AIzaSy..."
        />
        <p className="-mt-3 text-xs text-muted-foreground">
          Find it in browser DevTools under Application → IndexedDB → firebaseLocalStorageDb → firebaseLocalStorage → value.apiKey. If left blank, 9Router uses Merlin&apos;s known public Firebase client key.
        </p>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleImportToken}
            fullWidth
            disabled={importing || !sessionToken.trim()}
          >
            {importing ? "Importing..." : "Import Session"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

MerlinAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
