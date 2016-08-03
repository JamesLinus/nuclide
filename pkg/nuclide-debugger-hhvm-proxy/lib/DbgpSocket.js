'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */


import logger from './utils';
import {base64Decode, base64Encode} from './helpers';
import {EventEmitter} from 'events';
import {DbgpMessageHandler, getDbgpMessageHandlerInstance} from './DbgpMessageHandler';
import {attachEvent} from '../../commons-node/event';
import type {Socket} from 'net';

// Responses to the DBGP 'status' command
export const STATUS_STARTING = 'starting';
export const STATUS_STOPPING = 'stopping';
export const STATUS_STOPPED = 'stopped';
export const STATUS_RUNNING = 'running';
export const STATUS_BREAK = 'break';
// Error and End are not dbgp status codes, they relate to socket states.
export const STATUS_ERROR = 'error';
export const STATUS_END = 'end';
// stdout and stderr are emitted when DBGP sends the corresponding message packets.
export const STATUS_STDOUT = 'stdout';
export const STATUS_STDERR = 'stderr';

// Notifications.
export const BREAKPOINT_RESOLVED_NOTIFICATION = 'breakpoint_resolved';

// Valid continuation commands
export const COMMAND_RUN = 'run';
export const COMMAND_STEP_INTO = 'step_into';
export const COMMAND_STEP_OVER = 'step_over';
export const COMMAND_STEP_OUT = 'step_out';
export const COMMAND_STOP = 'stop';
export const COMMAND_DETACH = 'detach';

const DBGP_SOCKET_STATUS_EVENT = 'dbgp-socket-status';
const DBGP_SOCKET_NOTIFICATION_EVENT = 'dbgp-socket-notification';

export type DbgpContext = {
  name: string,
  id: string,
};

export type DbgpProperty = {
  $: {
    name?: string, // name and fullname are omitted when we get data back from the `eval` command.
    fullname?: string,
    address?: string,
    type: string,

    // array or object
    classname?: string,
    children?: boolean,
    numChildren?: number,
    page?: number,
    pagesize?: number,
    recursive?: number,

    // string
    size?: number,
    encoding?: string,
  },

  // Value if present, subject to encoding if present
  _?: string,

  // array or object members
  property?: Array<DbgpProperty>,
};

export type DbgpBreakpoint = {
  id: string,
  type: string,
  state: string,
  resolved?: string,
  hit_condition?: string,
  hit_count?: number,
  filename?: string,
  lineno?: number,
};

type EvaluationResult = {
  error?: Object,
  result?: ?DbgpProperty,
  wasThrown: boolean,
};

const DEFAULT_DBGP_PROPERTY: DbgpProperty = {
  $: {
    type: 'undefined',
  },
};

/**
 * Handles sending and recieving dbgp messages over a net Socket.
 * Dbgp documentation can be found at http://xdebug.org/docs-dbgp.php
 */
export class DbgpSocket {
  _socket: ?Socket;
  _transactionId: number;
  // Maps from transactionId -> call
  _calls: Map<number, {command: string, complete: (results: Object) => void}>;
  _emitter: EventEmitter;
  _isClosed: boolean;
  _messageHandler: DbgpMessageHandler;

  constructor(socket: Socket) {
    this._socket = socket;
    this._transactionId = 0;
    this._calls = new Map();
    this._emitter = new EventEmitter();
    this._isClosed = false;
    this._messageHandler = getDbgpMessageHandlerInstance();

    socket.on('end', this._onEnd.bind(this));
    socket.on('error', this._onError.bind(this));
    socket.on('data', this._onData.bind(this));
  }

  onStatus(callback: (status: string) => mixed): IDisposable {
    return attachEvent(this._emitter, DBGP_SOCKET_STATUS_EVENT, callback);
  }

  onNotification(callback: (notifyName: string, notify: Object) => mixed): IDisposable {
    return attachEvent(this._emitter, DBGP_SOCKET_NOTIFICATION_EVENT, callback);
  }

  _onError(error: {code: string}): void {
    // Not sure if hhvm is alive or not
    // do not set _isClosed flag so that detach will be sent before dispose().
    logger.logError('socket error ' + error.code);
    this._emitStatus(STATUS_ERROR, error.code);
  }

  _onEnd(): void {
    this._isClosed = true;
    this.dispose();
    this._emitStatus(STATUS_END);
  }

  _onData(data: Buffer | string): void {
    const message = data.toString();
    logger.log('Recieved data: ' + message);
    let responses = [];
    try {
      responses = this._messageHandler.parseMessages(message);
    } catch (e) {
      // If message parsing fails, then our contract with HHVM is violated and we need to kill the
      // connection.
      this._emitStatus(STATUS_ERROR, e.message);
      return;
    }
    responses.forEach(r => {
      const {response, stream, notify} = r;
      if (response) {
        this._handleResponse(response, message);
      } else if (stream != null) {
        this._handleStream(stream);
      } else if (notify != null) {
        this._handleNotification(notify);
      } else {
        logger.logError('Unexpected socket message: ' + message);
      }
    });
  }

  _handleResponse(response: Object, message: string): void {
    const responseAttributes = response.$;
    const {command, transaction_id} = responseAttributes;
    const transactionId = Number(transaction_id);
    const call = this._calls.get(transactionId);
    if (!call) {
      logger.logError('Missing call for response: ' + message);
      return;
    }
    this._calls.delete(transactionId);

    if (call.command !== command) {
      logger.logError('Bad command in response. Found ' +
        command + '. expected ' + call.command);
      return;
    }
    try {
      logger.log('Completing call: ' + message);
      call.complete(response);
    } catch (e) {
      logger.logError('Exception: ' + e.toString() + ' handling call: ' + message);
    }
  }

  _handleStream(stream: Object): void {
    const outputType = stream.$.type;
    // The body of the `stream` XML can be omitted, e.g. `echo null`, so we defend against this.
    const outputText = stream._ != null ? base64Decode(stream._) : '';
    logger.log(`${outputType} message received: ${outputText}`);
    const status = outputType === 'stdout' ? STATUS_STDOUT : STATUS_STDERR;
    this._emitStatus(status, outputText);
  }

  _handleNotification(notify: Object): void {
    const notifyName = notify.$.name;
    if (notifyName === 'breakpoint_resolved') {
      const breakpoint = notify.breakpoint[0].$;
      if (breakpoint == null) {
        logger.logError(
          `Fail to get breakpoint from 'breakpoint_resolved' notify: ${JSON.stringify(notify)}`,
        );
        return;
      }
      this._emitNotification(BREAKPOINT_RESOLVED_NOTIFICATION, breakpoint);
    } else {
      logger.logError(`Unknown notify: ${JSON.stringify(notify)}`);
    }
  }

  getStackFrames(): Promise<Object> {
    return this._callDebugger('stack_get');
  }

  async getContextsForFrame(frameIndex: number): Promise<Array<DbgpContext>> {
    const result = await this._callDebugger('context_names', `-d ${frameIndex}`);
    return result.context.map(context => context.$);
  }

  async getContextProperties(frameIndex: number, contextId: string): Promise<Array<DbgpProperty>> {
    const result = await this._callDebugger('context_get', `-d ${frameIndex} -c ${contextId}`);
    // 0 results yields missing 'property' member
    return result.property || [];
  }

  async getPropertiesByFullname(
    frameIndex: number,
    contextId: string,
    fullname: string,
    page: number,
  ): Promise<Array<DbgpProperty>> {
    // Escape any double quote in the expression.
    const escapedFullname = fullname.replace(/"/g, '\\"');
    const result = await this._callDebugger(
      'property_value',
      `-d ${frameIndex} -c ${contextId} -n "${escapedFullname}" -p ${page}`,
    );
    // property_value returns the outer property, we want the children ...
    // 0 results yields missing 'property' member
    if (result.property == null || result.property[0] == null) {
      return [];
    }
    return result.property[0].property || [];
  }

  async getPropertiesByFullnameAllConexts(
    frameIndex: number,
    fullname: string,
    page: number,
  ): Promise<Array<DbgpProperty>> {
    // Pass zero as contextId to search all contexts.
    return await this.getPropertiesByFullname(frameIndex, /* contextId */ '0', fullname, page);
  }

  async evaluateOnCallFrame(frameIndex: number, expression: string): Promise<EvaluationResult> {
    // Escape any double quote in the expression.
    const escapedExpression = expression.replace(/"/g, '\\"');
    // Quote the input expression so that we can support expression with
    // space in it(e.g. function evaluation).
    const result = await this._callDebugger(
      'property_value',
      `-d ${frameIndex} -n "${escapedExpression}"`,
    );
    if (result.error && result.error.length > 0) {
      return {
        error: result.error[0],
        wasThrown: true,
      };
    } else if (result.property != null) {
      return {
        result: result.property[0],
        wasThrown: false,
      };
    } else {
      logger.log(
        `Received non-error evaluateOnCallFrame response with no properties: ${expression}`,
      );
      return {
        result: DEFAULT_DBGP_PROPERTY,
        wasThrown: false,
      };
    }
  }

  // Returns one of:
  //  starting, stopping, stopped, running, break
  async getStatus(): Promise<string> {
    const response = await this._callDebugger('status');
    // TODO: Do we ever care about response.$.reason?
    return response.$.status;
  }

  // Continuation commands get a response, but that response
  // is a status message which occurs after execution stops.
  async sendContinuationCommand(command: string): Promise<string> {
    this._emitStatus(STATUS_RUNNING);
    const response = await this._callDebugger(command);
    const status = response.$.status;
    this._emitStatus(status);
    return status;
  }

  async sendBreakCommand(): Promise<boolean> {
    const response = await this._callDebugger('break');
    return response.$.success !== '0';
  }

  async sendStdoutRequest(): Promise<boolean> {
    // `-c 1` tells HHVM to send stdout to the normal destination, as well as forward it to nuclide.
    const response = await this._callDebugger('stdout', '-c 1');
    return response.$.success !== '0';
  }

  /**
   * Stderr forwarding is not implemented by HHVM yet so this will always return failure.
   */
  async sendStderrRequest(): Promise<boolean> {
    const response = await this._callDebugger('stderr', '-c 1');
    return response.$.success !== '0';
  }

  /**
   * Sets a given config setting in the debugger to a given value.
   */
  async setFeature(name: string, value: string): Promise<boolean> {
    const response = await this._callDebugger('feature_set', `-n ${name} -v ${value}`);
    return response.$.success !== '0';
  }

  /**
   * Evaluate the expression in the debugger's current context.
   */
  async runtimeEvaluate(expr: string): Promise<EvaluationResult> {
    const response = await this._callDebugger('eval', `-- ${base64Encode(expr)}`);
    if (response.error && response.error.length > 0) {
      return {
        error: response.error[0],
        wasThrown: true,
      };
    } else if (response.property != null) {
      return {
        result: response.property[0],
        wasThrown: false,
      };
    } else {
      logger.log(`Received non-error runtimeEvaluate response with no properties: ${expr}`);
      return {
        result: DEFAULT_DBGP_PROPERTY,
        wasThrown: false,
      };
    }
  }

  /**
   * Returns the exception breakpoint id.
   */
  async setExceptionBreakpoint(exceptionName: string): Promise<string> {
    const response = await this._callDebugger('breakpoint_set', `-t exception -x ${exceptionName}`);
    if (response.error) {
      throw new Error('Error from setPausedOnExceptions: ' + JSON.stringify(response));
    }
    // TODO: Validate that response.$.state === 'enabled'
    return response.$.id;
  }

  /**
   * Returns a breakpoint id
   */
  async setBreakpoint(filename: string, lineNumber: number): Promise<string> {
    const response = await this._callDebugger(
      'breakpoint_set',
      `-t line -f ${filename} -n ${lineNumber}`,
    );
    if (response.error) {
      throw new Error('Error setting breakpoint: ' + JSON.stringify(response));
    }
    // TODO: Validate that response.$.state === 'enabled'
    return response.$.id;
  }

  /**
   * Returns requested breakpoint object.
   */
  async getBreakpoint(breakpointId: string): Promise<DbgpBreakpoint> {
    const response = await this._callDebugger(
      'breakpoint_get',
      `-d ${breakpointId}`,
    );
    if (response.error != null ||
      response.breakpoint == null ||
      response.breakpoint[0] == null ||
      response.breakpoint[0].$ == null
    ) {
      throw new Error('Error getting breakpoint: ' + JSON.stringify(response));
    }
    return response.breakpoint[0].$;
  }

  async removeBreakpoint(breakpointId: string): Promise<any> {
    const response = await this._callDebugger('breakpoint_remove', `-d ${breakpointId}`);
    if (response.error) {
      throw new Error('Error removing breakpoint: ' + JSON.stringify(response));
    }
  }

  // Sends command to hhvm.
  // Returns an object containing the resulting attributes.
  _callDebugger(command: string, params: ?string): Promise<Object> {
    const transactionId = this._sendCommand(command, params);
    return new Promise((resolve, reject) => {
      this._calls.set(transactionId, {
        command,
        complete: result => resolve(result),
      });
    });
  }

  _sendCommand(command: string, params: ?string): number {
    const id = ++this._transactionId;
    let message = `${command} -i ${id}`;
    if (params) {
      message += ' ' + params;
    }
    this._sendMessage(message);
    return id;
  }

  _sendMessage(message: string): void {
    const socket = this._socket;
    if (socket != null) {
      logger.log('Sending message: ' + message);
      socket.write(message + '\x00');
    } else {
      logger.logError('Attempt to send message after dispose: ' + message);
    }
  }

  _emitStatus(status: string, ...args: Array<string>): void {
    logger.log('Emitting status: ' + status);
    this._emitter.emit(DBGP_SOCKET_STATUS_EVENT, status, ...args);
  }

  _emitNotification(notifyName: string, notify: Object): void {
    logger.log(`Emitting notification: ${notifyName}`);
    this._emitter.emit(DBGP_SOCKET_NOTIFICATION_EVENT, notifyName, notify);
  }

  dispose(): void {
    if (!this._isClosed) {
      // TODO[jeffreytan]: workaround a crash(t8181538) in hhvm
      this.sendContinuationCommand(COMMAND_DETACH);
    }

    const socket = this._socket;
    if (socket) {
      // end - Sends the FIN packet and closes writing.
      // destroy - closes for reading and writing.
      socket.end();
      socket.destroy();
      this._socket = null;
      this._isClosed = true;
    }
  }
}
