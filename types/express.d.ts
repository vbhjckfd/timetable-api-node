declare global {
  namespace Express {
    interface Request {
      /** Set by validateStopCode for the /stops/:code routes. */
      stopCode?: number;
    }
  }
}

export {};
