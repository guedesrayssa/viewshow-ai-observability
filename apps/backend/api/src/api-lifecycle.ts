interface CloseableServer {
  close(callback: (error?: Error) => void): void;
}

interface StoppableReconciler {
  stop(): Promise<void>;
}

export async function stopApiServices(input: {
  server: CloseableServer;
  reconciler: StoppableReconciler;
  stopTelemetry: () => Promise<void>;
}): Promise<Error | null> {
  const closeResult = new Promise<Error | null>((resolve) =>
    input.server.close((error) => resolve(error ?? null)),
  );
  await input.reconciler.stop();
  const serverError = await closeResult;
  await input.stopTelemetry();
  return serverError;
}
