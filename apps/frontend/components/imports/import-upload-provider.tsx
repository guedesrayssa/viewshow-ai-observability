"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError } from "@/lib/data/client";
import {
  ImportClient,
  createImportIdempotencyKey,
  type StartImportInput,
} from "@/lib/imports/client";
import {
  uploadImportFile,
  type UploadImportFileInput,
} from "@/lib/imports/multipart-upload";
import {
  isActiveImportState,
  isTerminalImportState,
  type ImportPage,
  type ImportSnapshot,
  type UploadProgress,
} from "@/lib/imports/types";

export type ImportConflictFeedback = Readonly<{
  importId: string;
  error: ApiError;
}>;

export type ImportUploadContextValue = {
  imports: readonly ImportSnapshot[];
  activeImport: ImportSnapshot | null;
  activeDatasetVersion: string | null;
  activatingVersion: string | null;
  nextCursor: string | null;
  transfer: "idle" | "starting" | "uploading" | "completing" | "failed";
  uploadProgress: UploadProgress | null;
  needsFileReselection: boolean;
  readError: ApiError | null;
  transferError: ApiError | null;
  conflict: ImportConflictFeedback | null;
  loading: boolean;
  loadingMore: boolean;
  startUpload(file: File, snapshotExtractedOn: string): Promise<void>;
  resumeUpload(file: File): Promise<void>;
  retryUpload(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  activate(importId: string): Promise<void>;
};

export type ImportUploadClient = Pick<
  ImportClient,
  | "list"
  | "get"
  | "start"
  | "listParts"
  | "signParts"
  | "restart"
  | "complete"
  | "activate"
>;

export type ImportUploadRunner = (
  input: UploadImportFileInput,
) => Promise<ImportSnapshot>;

type ProviderProps = {
  children: ReactNode;
  /**
   * Adia a primeira listagem até alguém usar `useImportUpload`. O provider
   * fica no layout do painel para que um envio em andamento sobreviva à
   * navegação, mas só a tela de Dados lê as importações: sem isto, toda tela
   * do painel pedia `/api/v1/imports?limit=50` ao abrir.
   */
  lazy?: boolean;
  client?: ImportUploadClient;
  uploadFile?: ImportUploadRunner;
  pollIntervalMs?: number;
  createIdempotencyKey?: typeof createImportIdempotencyKey;
};

type ActiveReadFence = {
  epoch: number;
  importId: string | null;
};

const ImportUploadContext = createContext<ImportUploadContextValue | null>(
  null,
);

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError")
    return new ApiError("A transferência foi cancelada.", undefined, "ABORTED");
  return new ApiError(
    error instanceof Error
      ? error.message
      : "Não foi possível continuar a importação.",
  );
}

function mergeSnapshot(
  current: ImportSnapshot | undefined,
  incoming: ImportSnapshot,
): ImportSnapshot {
  if (
    current &&
    isTerminalImportState(current.state) &&
    !isTerminalImportState(incoming.state)
  )
    return current;
  if (!current || incoming.version > current.version) return incoming;
  if (incoming.version < current.version) return current;
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  if (incomingUpdatedAt < currentUpdatedAt) return current;
  if (current.state !== incoming.state && isTerminalImportState(current.state))
    return current;
  if (
    current.state === incoming.state &&
    current.progress.kind === "bytes" &&
    incoming.progress.kind === "bytes" &&
    current.progress.totalBytes === incoming.progress.totalBytes
  )
    return {
      ...incoming,
      progress: {
        ...incoming.progress,
        completedBytes: Math.max(
          current.progress.completedBytes,
          incoming.progress.completedBytes,
        ),
      },
    };
  return incoming;
}

function mergeFirstPage(
  current: readonly ImportSnapshot[],
  incoming: readonly ImportSnapshot[],
): ImportSnapshot[] {
  const incomingIds = new Set(incoming.map((item) => item.importId));
  const byId = new Map(current.map((item) => [item.importId, item]));
  for (const item of incoming)
    byId.set(item.importId, mergeSnapshot(byId.get(item.importId), item));
  const order = [
    ...incoming.map((item) => item.importId),
    ...current
      .map((item) => item.importId)
      .filter((importId) => !incomingIds.has(importId)),
  ];
  return order.flatMap((importId) => {
    const item = byId.get(importId);
    return item ? [item] : [];
  });
}

function mergePage(
  current: readonly ImportSnapshot[],
  incoming: readonly ImportSnapshot[],
  append: boolean,
): ImportSnapshot[] {
  const order = append ? current.map((item) => item.importId) : [];
  const byId = new Map(current.map((item) => [item.importId, item]));
  for (const item of incoming) {
    if (!order.includes(item.importId)) order.push(item.importId);
    byId.set(item.importId, mergeSnapshot(byId.get(item.importId), item));
  }
  return order.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function newestFirst(items: readonly ImportSnapshot[]): ImportSnapshot[] {
  return [...items].sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
}

function localProgress(
  previous: UploadProgress | null,
  incoming: UploadProgress,
  durableConfirmed: number,
): UploadProgress {
  const totalBytes = Math.max(0, incoming.totalBytes);
  const incomingConfirmed = Math.min(
    totalBytes,
    Math.max(0, incoming.confirmedBytes),
  );
  const incomingVisible = Math.min(
    totalBytes,
    incomingConfirmed + Math.max(0, incoming.inFlightBytes),
  );
  const previousVisible =
    previous && previous.totalBytes === totalBytes
      ? Math.min(totalBytes, previous.confirmedBytes + previous.inFlightBytes)
      : 0;
  const visibleBytes = Math.min(
    totalBytes,
    Math.max(previousVisible, incomingVisible, durableConfirmed),
  );
  const confirmedBytes = Math.min(
    totalBytes,
    Math.max(incomingConfirmed, durableConfirmed),
  );
  return {
    confirmedBytes,
    inFlightBytes: Math.max(0, visibleBytes - confirmedBytes),
    totalBytes,
  };
}

/** Pede ao provider a primeira listagem, no modo `lazy`. */
const ImportLoadContext = createContext<(() => void) | null>(null);

export function ImportUploadProvider({
  children,
  lazy = false,
  client: injectedClient,
  uploadFile = uploadImportFile,
  pollIntervalMs = 5_000,
  createIdempotencyKey = createImportIdempotencyKey,
}: ProviderProps) {
  const [client] = useState<ImportUploadClient>(
    () => injectedClient ?? new ImportClient(),
  );

  const [imports, setImports] = useState<ImportSnapshot[]>([]);
  const [activeImport, setActiveImport] = useState<ImportSnapshot | null>(null);
  const [activeDatasetVersion, setActiveDatasetVersion] = useState<
    string | null
  >(null);
  const [activatingVersion, setActivatingVersion] = useState<string | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [transfer, setTransfer] =
    useState<ImportUploadContextValue["transfer"]>("idle");
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const [fileSelected, setFileSelected] = useState(false);
  const [readError, setReadError] = useState<ApiError | null>(null);
  const [transferError, setTransferError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState<ImportConflictFeedback | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadRequested, setLoadRequested] = useState(!lazy);
  const requestLoad = useCallback(() => setLoadRequested(true), []);

  const mountedRef = useRef(true);
  const activeRef = useRef<ImportSnapshot | null>(null);
  const activeEpochRef = useRef(0);
  const snapshotsRef = useRef(new Map<string, ImportSnapshot>());
  const bootstrappedRef = useRef(false);
  const loadedMoreRef = useRef(false);
  const bootstrapGenerationRef = useRef(0);
  const fileRef = useRef<File | null>(null);
  const transferControllerRef = useRef<AbortController | null>(null);
  const readControllersRef = useRef(new Set<AbortController>());
  const transferPromiseRef = useRef<Promise<ImportSnapshot> | null>(null);
  const actionKeysRef = useRef(
    new Map<string, { restart?: string; complete?: string }>(),
  );
  const startKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const activationKeysRef = useRef(new Map<string, string>());

  const resetLocalTransfer = useCallback((abort: boolean) => {
    if (abort) transferControllerRef.current?.abort();
    transferControllerRef.current = null;
    transferPromiseRef.current = null;
    fileRef.current = null;
    setFileSelected(false);
    setUploadProgress(null);
    setTransfer("idle");
  }, []);

  const canonicalizeSnapshot = useCallback((incoming: ImportSnapshot) => {
    const current = snapshotsRef.current.get(incoming.importId);
    const next = mergeSnapshot(current, incoming);
    snapshotsRef.current.set(incoming.importId, next);
    return next;
  }, []);

  const captureActiveFence = useCallback(
    (): ActiveReadFence => ({
      epoch: activeEpochRef.current,
      importId: activeRef.current?.importId ?? null,
    }),
    [],
  );

  const isActiveFenceCurrent = useCallback(
    (fence: ActiveReadFence) =>
      activeEpochRef.current === fence.epoch &&
      (activeRef.current?.importId ?? null) === fence.importId,
    [],
  );

  const rememberSnapshot = useCallback(
    (incoming: ImportSnapshot) => {
      const next = canonicalizeSnapshot(incoming);
      setImports((current) => newestFirst(mergePage(current, [next], true)));
      return next;
    },
    [canonicalizeSnapshot],
  );

  const publishSnapshot = useCallback(
    (incoming: ImportSnapshot, fence?: ActiveReadFence) => {
      const next = rememberSnapshot(incoming);
      if (fence && !isActiveFenceCurrent(fence)) return next;
      const currentActive = activeRef.current;
      if (isTerminalImportState(next.state)) {
        if (currentActive?.importId === next.importId) {
          activeEpochRef.current += 1;
          activeRef.current = null;
          setActiveImport(null);
          actionKeysRef.current.delete(next.importId);
          resetLocalTransfer(true);
          setTransferError(null);
          setConflict(null);
        }
        return next;
      }
      if (currentActive && currentActive.importId !== next.importId) {
        activeEpochRef.current += 1;
        actionKeysRef.current.delete(currentActive.importId);
        resetLocalTransfer(true);
        setTransferError(null);
      } else if (!currentActive) activeEpochRef.current += 1;
      setConflict((current) =>
        current?.importId === next.importId ? current : null,
      );
      activeRef.current = next;
      setActiveImport(next);
      if (next.progress.kind === "bytes") {
        const durableCompletedBytes = next.progress.completedBytes;
        setUploadProgress((previous) =>
          previous
            ? localProgress(previous, previous, durableCompletedBytes)
            : previous,
        );
      } else setUploadProgress(null);
      return next;
    },
    [isActiveFenceCurrent, rememberSnapshot, resetLocalTransfer],
  );

  const applyPage = useCallback(
    (
      page: ImportPage,
      mode: "replace" | "append" | "refresh",
      activeFence: ActiveReadFence | null = null,
      updatePagination = true,
    ) => {
      const items = page.items.map(canonicalizeSnapshot);
      setImports((current) => {
        if (mode === "replace" && updatePagination) return newestFirst(items);
        if (mode === "refresh" || !updatePagination)
          return newestFirst(mergeFirstPage(current, items));
        return newestFirst(mergePage(current, items, true));
      });
      if (updatePagination) {
        if (mode !== "refresh" || !loadedMoreRef.current)
          setNextCursor(page.cursor);
        if (mode === "append") loadedMoreRef.current = true;
      }
      if (page.activeDatasetVersion !== undefined)
        setActiveDatasetVersion(page.activeDatasetVersion);
      const active = items.find((item) => isActiveImportState(item.state));
      if (active && activeFence) publishSnapshot(active, activeFence);
    },
    [canonicalizeSnapshot, publishSnapshot],
  );

  const controlledRead = useCallback(
    async <T,>(read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      readControllersRef.current.add(controller);
      try {
        const result = await read(controller.signal);
        if (controller.signal.aborted)
          throw new DOMException("A leitura foi cancelada.", "AbortError");
        return result;
      } finally {
        readControllersRef.current.delete(controller);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const fence = captureActiveFence();
    try {
      const active = activeRef.current;
      if (active) {
        const record = await controlledRead((signal) =>
          client.get(active.importId, { signal }),
        );
        const fenceIsCurrent = isActiveFenceCurrent(fence);
        publishSnapshot(record, fence);
        if (fenceIsCurrent) setReadError(null);
        return;
      }
      const page = await controlledRead((signal) =>
        client.list({ limit: 50 }, { signal }),
      );
      const mode = bootstrappedRef.current ? "refresh" : "replace";
      const fenceIsCurrent = isActiveFenceCurrent(fence);
      applyPage(page, mode, null, fenceIsCurrent);
      if (fenceIsCurrent) bootstrappedRef.current = true;
      const nextActive = page.items.find((item) =>
        isActiveImportState(item.state),
      );
      if (nextActive) {
        const record = await controlledRead((signal) =>
          client.get(nextActive.importId, { signal }),
        );
        const readIsCurrent = isActiveFenceCurrent(fence);
        publishSnapshot(record, fence);
        if (readIsCurrent) setReadError(null);
      } else if (fenceIsCurrent) {
        setReadError(null);
        setConflict(null);
      }
    } catch (caught) {
      const failure = normalizeError(caught);
      if (failure.code !== "ABORTED" && isActiveFenceCurrent(fence))
        setReadError(failure);
      throw failure;
    }
  }, [
    applyPage,
    captureActiveFence,
    client,
    controlledRead,
    isActiveFenceCurrent,
    publishSnapshot,
  ]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const fence = captureActiveFence();
    setLoadingMore(true);
    try {
      const page = await controlledRead((signal) =>
        client.list({ limit: 50, cursor: nextCursor }, { signal }),
      );
      const fenceIsCurrent = isActiveFenceCurrent(fence);
      applyPage(page, "append", fenceIsCurrent ? fence : null, fenceIsCurrent);
      if (fenceIsCurrent) setReadError(null);
    } catch (caught) {
      const failure = normalizeError(caught);
      if (failure.code !== "ABORTED" && isActiveFenceCurrent(fence))
        setReadError(failure);
      throw failure;
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [
    applyPage,
    captureActiveFence,
    client,
    controlledRead,
    isActiveFenceCurrent,
    loadingMore,
    nextCursor,
  ]);

  const keyFor = useCallback(
    (importId: string, action: "restart" | "complete") => {
      const current = actionKeysRef.current.get(importId) ?? {};
      const existing = current[action];
      if (existing) return existing;
      const key = createIdempotencyKey(action);
      actionKeysRef.current.set(importId, { ...current, [action]: key });
      return key;
    },
    [createIdempotencyKey],
  );

  const confirmKey = useCallback(
    (importId: string, action: "restart" | "complete", key: string) => {
      const current = actionKeysRef.current.get(importId);
      if (!current || current[action] !== key) return;
      const next = { ...current };
      delete next[action];
      if (next.restart || next.complete)
        actionKeysRef.current.set(importId, next);
      else actionKeysRef.current.delete(importId);
    },
    [],
  );

  const launchTransfer = useCallback(
    (record: ImportSnapshot, file: File) => {
      transferControllerRef.current?.abort();
      const controller = new AbortController();
      transferControllerRef.current = controller;
      fileRef.current = file;
      setFileSelected(true);
      setTransferError(null);
      setTransfer("uploading");
      const promise = uploadFile({
        importRecord: record,
        file,
        client,
        signal: controller.signal,
        createIdempotencyKey: (action) => keyFor(record.importId, action),
        confirmIdempotencyKey: (action, key) =>
          confirmKey(record.importId, action, key),
        onPhase: (phase) => {
          if (transferControllerRef.current === controller) setTransfer(phase);
        },
        onProgress: (progress) => {
          if (transferControllerRef.current !== controller) return;
          const durable = activeRef.current;
          const durableConfirmed =
            durable?.progress.kind === "bytes"
              ? durable.progress.completedBytes
              : 0;
          setUploadProgress((previous) =>
            localProgress(previous, progress, durableConfirmed),
          );
        },
      });
      transferPromiseRef.current = promise;
      void promise
        .then((result) => {
          if (transferPromiseRef.current !== promise || !mountedRef.current)
            return;
          publishSnapshot(result);
          resetLocalTransfer(false);
        })
        .catch((caught: unknown) => {
          if (transferPromiseRef.current !== promise || !mountedRef.current)
            return;
          const failure = normalizeError(caught);
          if (failure.code === "ABORTED" && controller.signal.aborted) return;
          setTransferError(failure);
          setTransfer("failed");
        })
        .finally(() => {
          if (transferPromiseRef.current === promise)
            transferPromiseRef.current = null;
        });
    },
    [
      client,
      confirmKey,
      keyFor,
      publishSnapshot,
      resetLocalTransfer,
      uploadFile,
    ],
  );

  const startUpload = useCallback(
    async (file: File, snapshotExtractedOn: string) => {
      setTransfer("starting");
      setTransferError(null);
      setConflict(null);
      const body: StartImportInput = {
        fileName: file.name,
        sizeBytes: file.size,
        snapshotExtractedOn,
      };
      const fingerprint = `${body.fileName}\u0000${body.sizeBytes}\u0000${body.snapshotExtractedOn}`;
      if (startKeyRef.current?.fingerprint !== fingerprint)
        startKeyRef.current = {
          fingerprint,
          key: createIdempotencyKey("start"),
        };
      try {
        const record = await client.start(body, {
          idempotencyKey: startKeyRef.current.key,
        });
        startKeyRef.current = null;
        publishSnapshot(record);
        launchTransfer(record, file);
      } catch (caught) {
        const failure = normalizeError(caught);
        if (
          failure.code === "IMPORT_IN_PROGRESS" &&
          typeof failure.details?.importId === "string"
        ) {
          const conflictImportId = failure.details.importId;
          startKeyRef.current = null;
          const previousActive = activeRef.current;
          activeEpochRef.current += 1;
          activeRef.current = null;
          setActiveImport(null);
          if (previousActive)
            actionKeysRef.current.delete(previousActive.importId);
          resetLocalTransfer(true);
          setConflict({ importId: conflictImportId, error: failure });
          const conflictFence = captureActiveFence();
          try {
            const record = await controlledRead((signal) =>
              client.get(conflictImportId, { signal }),
            );
            const readIsCurrent = isActiveFenceCurrent(conflictFence);
            publishSnapshot(record, conflictFence);
            if (readIsCurrent) setReadError(null);
            return;
          } catch (resolutionError) {
            const resolutionFailure = normalizeError(resolutionError);
            if (
              resolutionFailure.code !== "ABORTED" &&
              isActiveFenceCurrent(conflictFence)
            )
              setReadError(resolutionFailure);
            throw resolutionFailure;
          }
        }
        setTransferError(failure);
        setTransfer("failed");
        throw failure;
      }
    },
    [
      client,
      captureActiveFence,
      controlledRead,
      createIdempotencyKey,
      isActiveFenceCurrent,
      launchTransfer,
      publishSnapshot,
      resetLocalTransfer,
    ],
  );

  const resumeUpload = useCallback(
    async (file: File) => {
      const active = activeRef.current;
      if (
        !active ||
        active.state !== "UPLOADING" ||
        !active.canManageUpload ||
        active.fileName !== file.name ||
        active.sizeBytes !== file.size
      )
        throw new Error("O arquivo selecionado não corresponde à importação.");
      launchTransfer(active, file);
    },
    [launchTransfer],
  );

  const retryUpload = useCallback(async () => {
    const active = activeRef.current;
    const file = fileRef.current;
    if (!active || !file)
      throw new Error("Selecione novamente o arquivo para retomar o upload.");
    launchTransfer(active, file);
  }, [launchTransfer]);

  const activate = useCallback(
    async (importId: string) => {
      const candidate = snapshotsRef.current.get(importId);
      if (candidate?.state !== "READY" || !candidate.candidateVersion)
        throw new Error("A importação ainda não está pronta para ativação.");
      const key =
        activationKeysRef.current.get(importId) ??
        createIdempotencyKey("activate");
      activationKeysRef.current.set(importId, key);
      setActivatingVersion(candidate.candidateVersion);
      try {
        const result = await client.activate(importId, {
          idempotencyKey: key,
        });
        if (!mountedRef.current) return;
        activationKeysRef.current.delete(importId);
        setActiveDatasetVersion(result.datasetVersion);
      } catch (caught) {
        const failure = normalizeError(caught);
        throw failure;
      } finally {
        if (mountedRef.current) setActivatingVersion(null);
      }
    },
    [client, createIdempotencyKey],
  );

  useEffect(() => {
    if (!loadRequested) return;
    const generation = bootstrapGenerationRef.current + 1;
    bootstrapGenerationRef.current = generation;
    mountedRef.current = true;
    const readControllers = readControllersRef.current;
    void Promise.resolve()
      .then(() => {
        if (
          !mountedRef.current ||
          bootstrapGenerationRef.current !== generation
        )
          return;
        return refresh();
      })
      .catch(() => {
        // O erro de leitura fica no slot próprio; as demais páginas continuam.
      })
      .finally(() => {
        if (mountedRef.current && bootstrapGenerationRef.current === generation)
          setLoading(false);
      });
    return () => {
      mountedRef.current = false;
      if (bootstrapGenerationRef.current === generation)
        bootstrapGenerationRef.current += 1;
      transferControllerRef.current?.abort();
      for (const controller of readControllers) controller.abort();
      readControllers.clear();
    };
  }, [loadRequested, refresh]);

  const activeImportId = activeImport?.importId;
  const activeImportState = activeImport?.state;
  useEffect(() => {
    const importId = activeImportId;
    if (
      !importId ||
      !activeImportState ||
      isTerminalImportState(activeImportState)
    )
      return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let refreshAfterFlight = false;
    const controller = new AbortController();
    const fence = captureActiveFence();
    const readControllers = readControllersRef.current;
    readControllers.add(controller);
    const isHidden = () => document.visibilityState === "hidden";

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (!disposed && !isHidden()) timer = setTimeout(run, pollIntervalMs);
    };
    const run = async () => {
      clearTimer();
      if (disposed || isHidden()) return;
      if (inFlight) {
        refreshAfterFlight = true;
        return;
      }
      inFlight = true;
      let shouldContinue = true;
      try {
        const record = await client.get(importId, {
          signal: controller.signal,
        });
        const readIsCurrent = isActiveFenceCurrent(fence);
        const published = disposed ? record : publishSnapshot(record, fence);
        if (!disposed && readIsCurrent) setReadError(null);
        shouldContinue = !isTerminalImportState(published.state);
      } catch (caught) {
        const failure = normalizeError(caught);
        if (
          !disposed &&
          failure.code !== "ABORTED" &&
          isActiveFenceCurrent(fence)
        )
          setReadError(failure);
      } finally {
        inFlight = false;
        if (disposed) return;
        if (shouldContinue && refreshAfterFlight && !isHidden()) {
          refreshAfterFlight = false;
          void run();
        } else if (shouldContinue) schedule();
      }
    };
    const onVisibility = () => {
      clearTimer();
      if (!isHidden()) void run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      disposed = true;
      clearTimer();
      controller.abort();
      readControllers.delete(controller);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    activeImportId,
    activeImportState,
    captureActiveFence,
    client,
    isActiveFenceCurrent,
    pollIntervalMs,
    publishSnapshot,
  ]);

  const value = useMemo<ImportUploadContextValue>(
    () => ({
      imports,
      activeImport,
      activeDatasetVersion,
      activatingVersion,
      nextCursor,
      transfer,
      uploadProgress,
      needsFileReselection:
        activeImport?.state === "UPLOADING" &&
        activeImport.canManageUpload &&
        !fileSelected,
      readError,
      transferError,
      conflict,
      loading,
      loadingMore,
      startUpload,
      resumeUpload,
      retryUpload,
      refresh,
      loadMore,
      activate,
    }),
    [
      activeImport,
      activeDatasetVersion,
      activatingVersion,
      activate,
      conflict,
      fileSelected,
      imports,
      loadMore,
      loading,
      loadingMore,
      nextCursor,
      readError,
      refresh,
      resumeUpload,
      retryUpload,
      startUpload,
      transfer,
      transferError,
      uploadProgress,
    ],
  );

  return (
    <ImportLoadContext.Provider value={requestLoad}>
      <ImportUploadContext.Provider value={value}>
        {children}
      </ImportUploadContext.Provider>
    </ImportLoadContext.Provider>
  );
}

export function useImportUpload(): ImportUploadContextValue {
  const context = useContext(ImportUploadContext);
  const requestLoad = useContext(ImportLoadContext);
  // Quem usa as importações é quem dispara a primeira listagem.
  useEffect(() => {
    requestLoad?.();
  }, [requestLoad]);
  if (!context)
    throw new Error(
      "useImportUpload precisa estar dentro de <ImportUploadProvider>.",
    );
  return context;
}
