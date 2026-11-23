import { DefaultFailureConverter } from "@temporalio/common";

/**
 * Converter that moves the message and the stack trace of a failure into a payload.
 *
 * The payload goes through the codec of the data converter, so the server keeps them encrypted.
 * Workers and clients load this file by its path, and Workers bundle it with the workflow code.
 */
export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });
