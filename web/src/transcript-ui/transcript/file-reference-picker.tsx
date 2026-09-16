import { ArrowLeftIcon, FileIcon, FolderIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  absoluteReferencePath,
  type FilePickerListing,
  type ListReferenceFiles,
} from "./file-references";

/** Host metadata only. Selecting a file returns its path; no file contents enter the browser. */
export function FileReferencePicker({
  listFiles,
  onSelect,
  onClose,
}: {
  listFiles: ListReferenceFiles;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const locationEdited = useRef(false);
  const [navigation, setNavigation] = useState(0);
  const [location, setLocation] = useState<string>();
  const [locationDraft, setLocationDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [listing, setListing] = useState<FilePickerListing>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void listFiles({ path: location, query: filter }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setListing(next);
        if (!locationEdited.current) setLocationDraft(next.path);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Files could not be listed.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listFiles, location, filter, navigation]);
  const navigate = (path: string) => {
    locationEdited.current = false;
    setFilter("");
    setLocation(path);
    setNavigation((value) => value + 1);
  };
  return (
    <dialog
      ref={dialog}
      className="transcript-file-picker"
      aria-labelledby="file-picker-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <h2 id="file-picker-title">Reference a file</h2>
        <button type="button" aria-label="Close file picker" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </button>
      </header>
      <p>Choose a file on the Agent host. Its full path is inserted as editable text.</p>
      <div className="transcript-file-picker__location">
        <button
          type="button"
          aria-label="Parent folder"
          disabled={loading || !listing?.parent}
          onClick={() => listing?.parent && navigate(listing.parent)}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </button>
        <label>
          Folder
          <input
            value={locationDraft}
            onChange={(event) => {
              locationEdited.current = true;
              setLocationDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const path = absoluteReferencePath(locationDraft);
              if (path) navigate(path);
              else setError("Enter an absolute folder path, such as /Users/you/Documents.");
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            const path = absoluteReferencePath(locationDraft);
            if (path) navigate(path);
            else setError("Enter an absolute folder path, such as /Users/you/Documents.");
          }}
        >
          Go
        </button>
      </div>
      <label className="transcript-file-picker__filter">
        Filter this folder
        <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="transcript-file-picker__entries" aria-busy={loading}>
        {loading ? (
          <p role="status">Loading files…</p>
        ) : error ? null : (
          <>
            {!listing?.entries.length ? (
              <p>No matching files or folders.</p>
            ) : (
              <ul>
                {listing.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() =>
                        entry.kind === "directory" ? navigate(entry.path) : onSelect(entry.path)
                      }
                    >
                      {entry.kind === "directory" ? (
                        <FolderIcon aria-hidden="true" />
                      ) : (
                        <FileIcon aria-hidden="true" />
                      )}
                      <span>{entry.name}</span>
                      <span className="transcript-file-picker__kind">
                        {entry.kind === "directory" ? "Open folder" : "Insert path"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {listing?.truncated ? (
              <p>More files are available. Filter this folder to narrow the list.</p>
            ) : null}
          </>
        )}
      </div>
      <footer>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </footer>
    </dialog>
  );
}
