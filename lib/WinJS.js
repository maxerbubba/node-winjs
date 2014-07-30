// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
/// <reference path="ms-appx://WinJS.2.1/js/WinJS.js" />
(function (global) {
    global.WinJS = global.WinJS || {};
    WinJS.Utilities = WinJS.Utilities || {};
    WinJS.Utilities._writeProfilerMark = function _writeProfilerMark(text) {
        global.msWriteProfilerMark && msWriteProfilerMark(text);
    };
})(this);
WinJS.Utilities._writeProfilerMark("WinJS.2.1 2.0.1.WinJS.2014.7.15 WinJS.js,StartTM");
(function (global, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        factory();
    }
}(this, function () {// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
/*jshint ignore:start */
var require;
var define;
/*jshint ignore:end */

(function() {
    "use strict";

    var defined = {};
    define = function(id, dependencies, factory) {
        if(!Array.isArray(dependencies)) {
            factory = dependencies;
            dependencies = [];
        }

        var mod = {
            dependencies: normalize(id, dependencies),
            factory: factory
        };

        if(dependencies.indexOf('exports') !== -1) {
            mod.exports = {};
        }

        defined[id] = mod;
    };

    // WinJS/Core depends on ./Core/_Base
    // should return WinJS/Core/_Base
    function normalize(id, dependencies) {
        var parent = id.split('/');
        parent.pop();
        return dependencies.map(function(dep) {
            if(dep[0] === '.') {
                var parts = dep.split('/');
                var current = parent.slice(0);
                parts.forEach(function(part) {
                    if(part === '..') {
                        current.pop();
                    } else if(part !== '.') {
                        current.push(part);
                    }
                });
                return current.join('/');
            } else {
                return dep;
            }
        });
    }

    function resolve(dependencies, exports) {
        return dependencies.map(function(depName) {
            if(depName === 'exports') {
                return exports;
            }
            var dep = defined[depName];
            if(!dep) {
                throw new Error("Undefined dependency: " + depName);
            }

            if(!dep.resolved) {
                dep.resolved = load(dep.dependencies, dep.factory, dep.exports);
                // exports shadows whatever the module factory returns
                if(dep.exports) {
                    dep.resolved = dep.exports;
                }
            }
            
            return dep.resolved;
        });
    }

    function load(dependencies, factory, exports) {
        var deps = resolve(dependencies, exports);
        if(factory && factory.apply) {
            return factory.apply(null, deps);
        } else {
            return factory;
        }
    }
    require = function(dependencies, factory) { //jshint ignore:line
        if(!Array.isArray(dependencies)) {
            dependencies = [dependencies];
        }
        load(dependencies, factory);
    };


})();
define("amd", function(){});

// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Promise/_StateMachine',[
    '../Core/_Global',
    '../Core/_BaseCoreUtils',
    '../Core/_Base',
    '../Core/_ErrorFromName',
    '../Core/_Events',
    '../Core/_Trace'
    ], function promiseStateMachineInit(_Global, _BaseCoreUtils, _Base, _ErrorFromName, _Events, _Trace) {
    "use strict";

    _Global.Debug && (_Global.Debug.setNonUserCodeExceptions = true);

    var ListenerType = _Base.Class.mix(_Base.Class.define(null, { /*empty*/ }, { supportedForProcessing: false }), _Events.eventMixin);
    var promiseEventListeners = new ListenerType();
    // make sure there is a listeners collection so that we can do a more trivial check below
    promiseEventListeners._listeners = {};
    var errorET = "error";
    var canceledName = "Canceled";
    var tagWithStack = false;
    var tag = {
        promise: 0x01,
        thenPromise: 0x02,
        errorPromise: 0x04,
        exceptionPromise: 0x08,
        completePromise: 0x10,
    };
    tag.all = tag.promise | tag.thenPromise | tag.errorPromise | tag.exceptionPromise | tag.completePromise;

    //
    // Global error counter, for each error which enters the system we increment this once and then
    // the error number travels with the error as it traverses the tree of potential handlers.
    //
    // When someone has registered to be told about errors (WinJS.Promise.callonerror) promises
    // which are in error will get tagged with a ._errorId field. This tagged field is the
    // contract by which nested promises with errors will be identified as chaining for the
    // purposes of the callonerror semantics. If a nested promise in error is encountered without
    // a ._errorId it will be assumed to be foreign and treated as an interop boundary and
    // a new error id will be minted.
    //
    var error_number = 1;

    //
    // The state machine has a interesting hiccup in it with regards to notification, in order
    // to flatten out notification and avoid recursion for synchronous completion we have an
    // explicit set of *_notify states which are responsible for notifying their entire tree
    // of children. They can do this because they know that immediate children are always
    // ThenPromise instances and we can therefore reach into their state to access the
    // _listeners collection.
    //
    // So, what happens is that a Promise will be fulfilled through the _completed or _error
    // messages at which point it will enter a *_notify state and be responsible for to move
    // its children into an (as appropriate) success or error state and also notify that child's
    // listeners of the state transition, until leaf notes are reached.
    //

    var state_created,              // -> working
        state_working,              // -> error | error_notify | success | success_notify | canceled | waiting
        state_waiting,              // -> error | error_notify | success | success_notify | waiting_canceled
        state_waiting_canceled,     // -> error | error_notify | success | success_notify | canceling
        state_canceled,             // -> error | error_notify | success | success_notify | canceling
        state_canceling,            // -> error_notify
        state_success_notify,       // -> success
        state_success,              // -> .
        state_error_notify,         // -> error
        state_error;                // -> .

    // Noop function, used in the various states to indicate that they don't support a given
    // message. Named with the somewhat cute name '_' because it reads really well in the states.

    function _() { }

    // Initial state
    //
    state_created = {
        name: "created",
        enter: function (promise) {
            promise._setState(state_working);
        },
        cancel: _,
        done: _,
        then: _,
        _completed: _,
        _error: _,
        _notify: _,
        _progress: _,
        _setCompleteValue: _,
        _setErrorValue: _
    };

    // Ready state, waiting for a message (completed/error/progress), able to be canceled
    //
    state_working = {
        name: "working",
        enter: _,
        cancel: function (promise) {
            promise._setState(state_canceled);
        },
        done: done,
        then: then,
        _completed: completed,
        _error: error,
        _notify: _,
        _progress: progress,
        _setCompleteValue: setCompleteValue,
        _setErrorValue: setErrorValue
    };

    // Waiting state, if a promise is completed with a value which is itself a promise
    // (has a then() method) it signs up to be informed when that child promise is
    // fulfilled at which point it will be fulfilled with that value.
    //
    state_waiting = {
        name: "waiting",
        enter: function (promise) {
            var waitedUpon = promise._value;
            // We can special case our own intermediate promises which are not in a 
            //  terminal state by just pushing this promise as a listener without 
            //  having to create new indirection functions
            if (waitedUpon instanceof ThenPromise &&
                waitedUpon._state !== state_error &&
                waitedUpon._state !== state_success) {
                pushListener(waitedUpon, { promise: promise });
            } else {
                var error = function (value) {
                    if (waitedUpon._errorId) {
                        promise._chainedError(value, waitedUpon);
                    } else {
                        // Because this is an interop boundary we want to indicate that this 
                        //  error has been handled by the promise infrastructure before we
                        //  begin a new handling chain.
                        //
                        callonerror(promise, value, detailsForHandledError, waitedUpon, error);
                        promise._error(value);
                    }
                };
                error.handlesOnError = true;
                waitedUpon.then(
                    promise._completed.bind(promise),
                    error,
                    promise._progress.bind(promise)
                );
            }
        },
        cancel: function (promise) {
            promise._setState(state_waiting_canceled);
        },
        done: done,
        then: then,
        _completed: completed,
        _error: error,
        _notify: _,
        _progress: progress,
        _setCompleteValue: setCompleteValue,
        _setErrorValue: setErrorValue
    };

    // Waiting canceled state, when a promise has been in a waiting state and receives a
    // request to cancel its pending work it will forward that request to the child promise
    // and then waits to be informed of the result. This promise moves itself into the
    // canceling state but understands that the child promise may instead push it to a
    // different state.
    //
    state_waiting_canceled = {
        name: "waiting_canceled",
        enter: function (promise) {
            // Initiate a transition to canceling. Triggering a cancel on the promise
            // that we are waiting upon may result in a different state transition
            // before the state machine pump runs again.
            promise._setState(state_canceling);
            var waitedUpon = promise._value;
            if (waitedUpon.cancel) {
                waitedUpon.cancel();
            }
        },
        cancel: _,
        done: done,
        then: then,
        _completed: completed,
        _error: error,
        _notify: _,
        _progress: progress,
        _setCompleteValue: setCompleteValue,
        _setErrorValue: setErrorValue
    };

    // Canceled state, moves to the canceling state and then tells the promise to do
    // whatever it might need to do on cancelation.
    //
    state_canceled = {
        name: "canceled",
        enter: function (promise) {
            // Initiate a transition to canceling. The _cancelAction may change the state
            // before the state machine pump runs again.
            promise._setState(state_canceling);
            promise._cancelAction();
        },
        cancel: _,
        done: done,
        then: then,
        _completed: completed,
        _error: error,
        _notify: _,
        _progress: progress,
        _setCompleteValue: setCompleteValue,
        _setErrorValue: setErrorValue
    };

    // Canceling state, commits to the promise moving to an error state with an error
    // object whose 'name' and 'message' properties contain the string "Canceled"
    //
    state_canceling = {
        name: "canceling",
        enter: function (promise) {
            var error = new Error(canceledName);
            error.name = error.message;
            promise._value = error;
            promise._setState(state_error_notify);
        },
        cancel: _,
        done: _,
        then: _,
        _completed: _,
        _error: _,
        _notify: _,
        _progress: _,
        _setCompleteValue: _,
        _setErrorValue: _
    };

    // Success notify state, moves a promise to the success state and notifies all children
    //
    state_success_notify = {
        name: "complete_notify",
        enter: function (promise) {
            promise.done = CompletePromise.prototype.done;
            promise.then = CompletePromise.prototype.then;
            if (promise._listeners) {
                var queue = [promise];
                var p;
                while (queue.length) {
                    p = queue.shift();
                    p._state._notify(p, queue);
                }
            }
            promise._setState(state_success);
        },
        cancel: _,
        done: null, /*error to get here */
        then: null, /*error to get here */
        _completed: _,
        _error: _,
        _notify: notifySuccess,
        _progress: _,
        _setCompleteValue: _,
        _setErrorValue: _
    };

    // Success state, moves a promise to the success state and does NOT notify any children.
    // Some upstream promise is owning the notification pass.
    //
    state_success = {
        name: "success",
        enter: function (promise) {
            promise.done = CompletePromise.prototype.done;
            promise.then = CompletePromise.prototype.then;
            promise._cleanupAction();
        },
        cancel: _,
        done: null, /*error to get here */
        then: null, /*error to get here */
        _completed: _,
        _error: _,
        _notify: notifySuccess,
        _progress: _,
        _setCompleteValue: _,
        _setErrorValue: _
    };

    // Error notify state, moves a promise to the error state and notifies all children
    //
    state_error_notify = {
        name: "error_notify",
        enter: function (promise) {
            promise.done = ErrorPromise.prototype.done;
            promise.then = ErrorPromise.prototype.then;
            if (promise._listeners) {
                var queue = [promise];
                var p;
                while (queue.length) {
                    p = queue.shift();
                    p._state._notify(p, queue);
                }
            }
            promise._setState(state_error);
        },
        cancel: _,
        done: null, /*error to get here*/
        then: null, /*error to get here*/
        _completed: _,
        _error: _,
        _notify: notifyError,
        _progress: _,
        _setCompleteValue: _,
        _setErrorValue: _
    };

    // Error state, moves a promise to the error state and does NOT notify any children.
    // Some upstream promise is owning the notification pass.
    //
    state_error = {
        name: "error",
        enter: function (promise) {
            promise.done = ErrorPromise.prototype.done;
            promise.then = ErrorPromise.prototype.then;
            promise._cleanupAction();
        },
        cancel: _,
        done: null, /*error to get here*/
        then: null, /*error to get here*/
        _completed: _,
        _error: _,
        _notify: notifyError,
        _progress: _,
        _setCompleteValue: _,
        _setErrorValue: _
    };

    //
    // The statemachine implementation follows a very particular pattern, the states are specified
    // as static stateless bags of functions which are then indirected through the state machine
    // instance (a Promise). As such all of the functions on each state have the promise instance
    // passed to them explicitly as a parameter and the Promise instance members do a little
    // dance where they indirect through the state and insert themselves in the argument list.
    //
    // We could instead call directly through the promise states however then every caller
    // would have to remember to do things like pumping the state machine to catch state transitions.
    //

    var PromiseStateMachine = _Base.Class.define(null, {
        _listeners: null,
        _nextState: null,
        _state: null,
        _value: null,

        cancel: function () {
            /// <signature helpKeyword="WinJS.PromiseStateMachine.cancel">
            /// <summary locid="WinJS.PromiseStateMachine.cancel">
            /// Attempts to cancel the fulfillment of a promised value. If the promise hasn't
            /// already been fulfilled and cancellation is supported, the promise enters
            /// the error state with a value of Error("Canceled").
            /// </summary>
            /// </signature>
            this._state.cancel(this);
            this._run();
        },
        done: function Promise_done(onComplete, onError, onProgress) {
            /// <signature helpKeyword="WinJS.PromiseStateMachine.done">
            /// <summary locid="WinJS.PromiseStateMachine.done">
            /// Allows you to specify the work to be done on the fulfillment of the promised value,
            /// the error handling to be performed if the promise fails to fulfill
            /// a value, and the handling of progress notifications along the way.
            ///
            /// After the handlers have finished executing, this function throws any error that would have been returned
            /// from then() as a promise in the error state.
            /// </summary>
            /// <param name='onComplete' type='Function' locid="WinJS.PromiseStateMachine.done_p:onComplete">
            /// The function to be called if the promise is fulfilled successfully with a value.
            /// The fulfilled value is passed as the single argument. If the value is null,
            /// the fulfilled value is returned. The value returned
            /// from the function becomes the fulfilled value of the promise returned by
            /// then(). If an exception is thrown while executing the function, the promise returned
            /// by then() moves into the error state.
            /// </param>
            /// <param name='onError' type='Function' optional='true' locid="WinJS.PromiseStateMachine.done_p:onError">
            /// The function to be called if the promise is fulfilled with an error. The error
            /// is passed as the single argument. If it is null, the error is forwarded.
            /// The value returned from the function is the fulfilled value of the promise returned by then().
            /// </param>
            /// <param name='onProgress' type='Function' optional='true' locid="WinJS.PromiseStateMachine.done_p:onProgress">
            /// the function to be called if the promise reports progress. Data about the progress
            /// is passed as the single argument. Promises are not required to support
            /// progress.
            /// </param>
            /// </signature>
            this._state.done(this, onComplete, onError, onProgress);
        },
        then: function Promise_then(onComplete, onError, onProgress) {
            /// <signature helpKeyword="WinJS.PromiseStateMachine.then">
            /// <summary locid="WinJS.PromiseStateMachine.then">
            /// Allows you to specify the work to be done on the fulfillment of the promised value,
            /// the error handling to be performed if the promise fails to fulfill
            /// a value, and the handling of progress notifications along the way.
            /// </summary>
            /// <param name='onComplete' type='Function' locid="WinJS.PromiseStateMachine.then_p:onComplete">
            /// The function to be called if the promise is fulfilled successfully with a value.
            /// The value is passed as the single argument. If the value is null, the value is returned.
            /// The value returned from the function becomes the fulfilled value of the promise returned by
            /// then(). If an exception is thrown while this function is being executed, the promise returned
            /// by then() moves into the error state.
            /// </param>
            /// <param name='onError' type='Function' optional='true' locid="WinJS.PromiseStateMachine.then_p:onError">
            /// The function to be called if the promise is fulfilled with an error. The error
            /// is passed as the single argument. If it is null, the error is forwarded.
            /// The value returned from the function becomes the fulfilled value of the promise returned by then().
            /// </param>
            /// <param name='onProgress' type='Function' optional='true' locid="WinJS.PromiseStateMachine.then_p:onProgress">
            /// The function to be called if the promise reports progress. Data about the progress
            /// is passed as the single argument. Promises are not required to support
            /// progress.
            /// </param>
            /// <returns type="WinJS.Promise" locid="WinJS.PromiseStateMachine.then_returnValue">
            /// The promise whose value is the result of executing the complete or
            /// error function.
            /// </returns>
            /// </signature>
            return this._state.then(this, onComplete, onError, onProgress);
        },

        _chainedError: function (value, context) {
            var result = this._state._error(this, value, detailsForChainedError, context);
            this._run();
            return result;
        },
        _completed: function (value) {
            var result = this._state._completed(this, value);
            this._run();
            return result;
        },
        _error: function (value) {
            var result = this._state._error(this, value, detailsForError);
            this._run();
            return result;
        },
        _progress: function (value) {
            this._state._progress(this, value);
        },
        _setState: function (state) {
            this._nextState = state;
        },
        _setCompleteValue: function (value) {
            this._state._setCompleteValue(this, value);
            this._run();
        },
        _setChainedErrorValue: function (value, context) {
            var result = this._state._setErrorValue(this, value, detailsForChainedError, context);
            this._run();
            return result;
        },
        _setExceptionValue: function (value) {
            var result = this._state._setErrorValue(this, value, detailsForException);
            this._run();
            return result;
        },
        _run: function () {
            while (this._nextState) {
                this._state = this._nextState;
                this._nextState = null;
                this._state.enter(this);
            }
        }
    }, {
        supportedForProcessing: false
    });

    //
    // Implementations of shared state machine code.
    //

    function completed(promise, value) {
        var targetState;
        if (value && typeof value === "object" && typeof value.then === "function") {
            targetState = state_waiting;
        } else {
            targetState = state_success_notify;
        }
        promise._value = value;
        promise._setState(targetState);
    }
    function createErrorDetails(exception, error, promise, id, parent, handler) {
        return {
            exception: exception,
            error: error,
            promise: promise,
            handler: handler,
            id: id,
            parent: parent
        };
    }
    function detailsForHandledError(promise, errorValue, context, handler) {
        var exception = context._isException;
        var errorId = context._errorId;
        return createErrorDetails(
            exception ? errorValue : null,
            exception ? null : errorValue,
            promise,
            errorId,
            context,
            handler
        );
    }
    function detailsForChainedError(promise, errorValue, context) {
        var exception = context._isException;
        var errorId = context._errorId;
        setErrorInfo(promise, errorId, exception);
        return createErrorDetails(
            exception ? errorValue : null,
            exception ? null : errorValue,
            promise,
            errorId,
            context
        );
    }
    function detailsForError(promise, errorValue) {
        var errorId = ++error_number;
        setErrorInfo(promise, errorId);
        return createErrorDetails(
            null,
            errorValue,
            promise,
            errorId
        );
    }
    function detailsForException(promise, exceptionValue) {
        var errorId = ++error_number;
        setErrorInfo(promise, errorId, true);
        return createErrorDetails(
            exceptionValue,
            null,
            promise,
            errorId
        );
    }
    function done(promise, onComplete, onError, onProgress) {
        var asyncOpID = _Trace._traceAsyncOperationStarting("WinJS.Promise.done");
        pushListener(promise, { c: onComplete, e: onError, p: onProgress, asyncOpID: asyncOpID });
    }
    function error(promise, value, onerrorDetails, context) {
        promise._value = value;
        callonerror(promise, value, onerrorDetails, context);
        promise._setState(state_error_notify);
    }
    function notifySuccess(promise, queue) {
        var value = promise._value;
        var listeners = promise._listeners;
        if (!listeners) {
            return;
        }
        promise._listeners = null;
        var i, len;
        for (i = 0, len = Array.isArray(listeners) ? listeners.length : 1; i < len; i++) {
            var listener = len === 1 ? listeners : listeners[i];
            var onComplete = listener.c;
            var target = listener.promise;

            _Trace._traceAsyncOperationCompleted(listener.asyncOpID, _Global.Debug && _Global.Debug.MS_ASYNC_OP_STATUS_SUCCESS);

            if (target) {
                _Trace._traceAsyncCallbackStarting(listener.asyncOpID);
                try {
                    target._setCompleteValue(onComplete ? onComplete(value) : value);
                } catch (ex) {
                    target._setExceptionValue(ex);
                } finally {
                    _Trace._traceAsyncCallbackCompleted();
                }
                if (target._state !== state_waiting && target._listeners) {
                    queue.push(target);
                }
            } else {
                CompletePromise.prototype.done.call(promise, onComplete);
            }
        }
    }
    function notifyError(promise, queue) {
        var value = promise._value;
        var listeners = promise._listeners;
        if (!listeners) {
            return;
        }
        promise._listeners = null;
        var i, len;
        for (i = 0, len = Array.isArray(listeners) ? listeners.length : 1; i < len; i++) {
            var listener = len === 1 ? listeners : listeners[i];
            var onError = listener.e;
            var target = listener.promise;

            var errorID = _Global.Debug && (value && value.name === canceledName ? _Global.Debug.MS_ASYNC_OP_STATUS_CANCELED : _Global.Debug.MS_ASYNC_OP_STATUS_ERROR);
            _Trace._traceAsyncOperationCompleted(listener.asyncOpID, errorID);

            if (target) {
                var asyncCallbackStarted = false;
                try {
                    if (onError) {
                        _Trace._traceAsyncCallbackStarting(listener.asyncOpID);
                        asyncCallbackStarted = true;
                        if (!onError.handlesOnError) {
                            callonerror(target, value, detailsForHandledError, promise, onError);
                        }
                        target._setCompleteValue(onError(value));
                    } else {
                        target._setChainedErrorValue(value, promise);
                    }
                } catch (ex) {
                    target._setExceptionValue(ex);
                } finally {
                    if (asyncCallbackStarted) {
                        _Trace._traceAsyncCallbackCompleted();
                    }
                }
                if (target._state !== state_waiting && target._listeners) {
                    queue.push(target);
                }
            } else {
                ErrorPromise.prototype.done.call(promise, null, onError);
            }
        }
    }
    function callonerror(promise, value, onerrorDetailsGenerator, context, handler) {
        if (promiseEventListeners._listeners[errorET]) {
            if (value instanceof Error && value.message === canceledName) {
                return;
            }
            promiseEventListeners.dispatchEvent(errorET, onerrorDetailsGenerator(promise, value, context, handler));
        }
    }
    function progress(promise, value) {
        var listeners = promise._listeners;
        if (listeners) {
            var i, len;
            for (i = 0, len = Array.isArray(listeners) ? listeners.length : 1; i < len; i++) {
                var listener = len === 1 ? listeners : listeners[i];
                var onProgress = listener.p;
                if (onProgress) {
                    try { onProgress(value); } catch (ex) { }
                }
                if (!(listener.c || listener.e) && listener.promise) {
                    listener.promise._progress(value);
                }
            }
        }
    }
    function pushListener(promise, listener) {
        var listeners = promise._listeners;
        if (listeners) {
            // We may have either a single listener (which will never be wrapped in an array)
            // or 2+ listeners (which will be wrapped). Since we are now adding one more listener
            // we may have to wrap the single listener before adding the second.
            listeners = Array.isArray(listeners) ? listeners : [listeners];
            listeners.push(listener);
        } else {
            listeners = listener;
        }
        promise._listeners = listeners;
    }
    // The difference beween setCompleteValue()/setErrorValue() and complete()/error() is that setXXXValue() moves
    // a promise directly to the success/error state without starting another notification pass (because one
    // is already ongoing).
    function setErrorInfo(promise, errorId, isException) {
        promise._isException = isException || false;
        promise._errorId = errorId;
    }
    function setErrorValue(promise, value, onerrorDetails, context) {
        promise._value = value;
        callonerror(promise, value, onerrorDetails, context);
        promise._setState(state_error);
    }
    function setCompleteValue(promise, value) {
        var targetState;
        if (value && typeof value === "object" && typeof value.then === "function") {
            targetState = state_waiting;
        } else {
            targetState = state_success;
        }
        promise._value = value;
        promise._setState(targetState);
    }
    function then(promise, onComplete, onError, onProgress) {
        var result = new ThenPromise(promise);
        var asyncOpID = _Trace._traceAsyncOperationStarting("WinJS.Promise.then");
        pushListener(promise, { promise: result, c: onComplete, e: onError, p: onProgress, asyncOpID: asyncOpID });
        return result;
    }

    //
    // Internal implementation detail promise, ThenPromise is created when a promise needs
    // to be returned from a then() method.
    //
    var ThenPromise = _Base.Class.derive(PromiseStateMachine,
        function (creator) {

            if (tagWithStack && (tagWithStack === true || (tagWithStack & tag.thenPromise))) {
                this._stack = Promise._getStack();
            }

            this._creator = creator;
            this._setState(state_created);
            this._run();
        }, {
            _creator: null,

            _cancelAction: function () { if (this._creator) { this._creator.cancel(); } },
            _cleanupAction: function () { this._creator = null; }
        }, {
            supportedForProcessing: false
        }
    );

    //
    // Slim promise implementations for already completed promises, these are created
    // under the hood on synchronous completion paths as well as by WinJS.Promise.wrap
    // and WinJS.Promise.wrapError.
    //

    var ErrorPromise = _Base.Class.define(
        function ErrorPromise_ctor(value) {

            if (tagWithStack && (tagWithStack === true || (tagWithStack & tag.errorPromise))) {
                this._stack = Promise._getStack();
            }

            this._value = value;
            callonerror(this, value, detailsForError);
        }, {
            cancel: function () {
                /// <signature helpKeyword="WinJS.PromiseStateMachine.cancel">
                /// <summary locid="WinJS.PromiseStateMachine.cancel">
                /// Attempts to cancel the fulfillment of a promised value. If the promise hasn't
                /// already been fulfilled and cancellation is supported, the promise enters
                /// the error state with a value of Error("Canceled").
                /// </summary>
                /// </signature>
            },
            done: function ErrorPromise_done(unused, onError) {
                /// <signature helpKeyword="WinJS.PromiseStateMachine.done">
                /// <summary locid="WinJS.PromiseStateMachine.done">
                /// Allows you to specify the work to be done on the fulfillment of the promised value,
                /// the error handling to be performed if the promise fails to fulfill
                /// a value, and the handling of progress notifications along the way.
                ///
                /// After the handlers have finished executing, this function throws any error that would have been returned
                /// from then() as a promise in the error state.
                /// </summary>
                /// <param name='onComplete' type='Function' locid="WinJS.PromiseStateMachine.done_p:onComplete">
                /// The function to be called if the promise is fulfilled successfully with a value.
                /// The fulfilled value is passed as the single argument. If the value is null,
                /// the fulfilled value is returned. The value returned
                /// from the function becomes the fulfilled value of the promise returned by
                /// then(). If an exception is thrown while executing the function, the promise returned
                /// by then() moves into the error state.
                /// </param>
                /// <param name='onError' type='Function' optional='true' locid="WinJS.PromiseStateMachine.done_p:onError">
                /// The function to be called if the promise is fulfilled with an error. The error
                /// is passed as the single argument. If it is null, the error is forwarded.
                /// The value returned from the function is the fulfilled value of the promise returned by then().
                /// </param>
                /// <param name='onProgress' type='Function' optional='true' locid="WinJS.PromiseStateMachine.done_p:onProgress">
                /// the function to be called if the promise reports progress. Data about the progress
                /// is passed as the single argument. Promises are not required to support
                /// progress.
                /// </param>
                /// </signature>
                var value = this._value;
                if (onError) {
                    try {
                        if (!onError.handlesOnError) {
                            callonerror(null, value, detailsForHandledError, this, onError);
                        }
                        var result = onError(value);
                        if (result && typeof result === "object" && typeof result.done === "function") {
                            // If a promise is returned we need to wait on it.
                            result.done();
                        }
                        return;
                    } catch (ex) {
                        value = ex;
                    }
                }
                if (value instanceof Error && value.message === canceledName) {
                    // suppress cancel
                    return;
                }
                // force the exception to be thrown asyncronously to avoid any try/catch blocks
                //
                Promise._doneHandler(value);
            },
            then: function ErrorPromise_then(unused, onError) {
                /// <signature helpKeyword="WinJS.PromiseStateMachine.then">
                /// <summary locid="WinJS.PromiseStateMachine.then">
                /// Allows you to specify the work to be done on the fulfillment of the promised value,
                /// the error handling to be performed if the promise fails to fulfill
                /// a value, and the handling of progress notifications along the way.
                /// </summary>
                /// <param name='onComplete' type='Function' locid="WinJS.PromiseStateMachine.then_p:onComplete">
                /// The function to be called if the promise is fulfilled successfully with a value.
                /// The value is passed as the single argument. If the value is null, the value is returned.
                /// The value returned from the function becomes the fulfilled value of the promise returned by
                /// then(). If an exception is thrown while this function is being executed, the promise returned
                /// by then() moves into the error state.
                /// </param>
                /// <param name='onError' type='Function' optional='true' locid="WinJS.PromiseStateMachine.then_p:onError">
                /// The function to be called if the promise is fulfilled with an error. The error
                /// is passed as the single argument. If it is null, the error is forwarded.
                /// The value returned from the function becomes the fulfilled value of the promise returned by then().
                /// </param>
                /// <param name='onProgress' type='Function' optional='true' locid="WinJS.PromiseStateMachine.then_p:onProgress">
                /// The function to be called if the promise reports progress. Data about the progress
                /// is passed as the single argument. Promises are not required to support
                /// progress.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.PromiseStateMachine.then_returnValue">
                /// The promise whose value is the result of executing the complete or
                /// error function.
                /// </returns>
                /// </signature>

                // If the promise is already in a error state and no error handler is provided
                // we optimize by simply returning the promise instead of creating a new one.
                //
                if (!onError) { return this; }
                var result;
                var value = this._value;
                try {
                    if (!onError.handlesOnError) {
                        callonerror(null, value, detailsForHandledError, this, onError);
                    }
                    result = new CompletePromise(onError(value));
                } catch (ex) {
                    // If the value throw from the error handler is the same as the value
                    // provided to the error handler then there is no need for a new promise.
                    //
                    if (ex === value) {
                        result = this;
                    } else {
                        result = new ExceptionPromise(ex);
                    }
                }
                return result;
            }
        }, {
            supportedForProcessing: false
        }
    );

    var ExceptionPromise = _Base.Class.derive(ErrorPromise,
        function ExceptionPromise_ctor(value) {

            if (tagWithStack && (tagWithStack === true || (tagWithStack & tag.exceptionPromise))) {
                this._stack = Promise._getStack();
            }

            this._value = value;
            callonerror(this, value, detailsForException);
        }, {
            /* empty */
        }, {
            supportedForProcessing: false
        }
    );

    var CompletePromise = _Base.Class.define(
        function CompletePromise_ctor(value) {

            if (tagWithStack && (tagWithStack === true || (tagWithStack & tag.completePromise))) {
                this._stack = Promise._getStack();
            }

            if (value && typeof value === "object" && typeof value.then === "function") {
                var result = new ThenPromise(null);
                result._setCompleteValue(value);
                return result;
            }
            this._value = value;
        }, {
            cancel: function () {
                /// <signature helpKeyword="WinJS.PromiseStateMachine.cancel">
                /// <summary locid="WinJS.PromiseStateMachine.cancel">
                /// Attempts to cancel the fulfillment of a promised value. If the promise hasn't
                /// already been fulfilled and cancellation is supported, the promise enters
                /// the error state with a value of Error("Canceled").
                /// </summary>
                /// </signature>
            },
            done: function CompletePromise_done(onComplete) {
                /// <signature helpKeyword="WinJS.PromiseStateMachine.done">
                /// <summary locid="WinJS.PromiseStateMachine.done">
                /// Allows you to specify the work to be done on the fulfillment of the promised value,
                /// the error handling to be performed if the promise fails to fulfill
                /// a value, and the handling of progress notifications along the way.
                ///
                /// After the handlers have finished executing, this function throws any error that would have been returned
                /// from then() as a promise in the error state.
                /// </summary>
                /// <param name='onComplete' type='Function' locid="WinJS.PromiseStateMachine.done_p:onComplete">
                /// The function to be called if the promise is fulfilled successfully with a value.
                /// The fulfilled value is passed as the single argument. If the value is null,
                /// the fulfilled value is returned. The value returned
                /// from the function becomes the fulfilled value of the promise returned by
                /// then(). If an exception is thrown while executing the function, the promise returned
                /// by then() moves into the error state.
                /// </param>
                /// <param name='onError' type='Function' optional='true' locid="WinJS.PromiseStateMachine.done_p:onError">
                /// The function to be called if the promise is fulfilled with an error. The error
                /// is passed as the single argument. If it is null, the error is forwarded.
                /// The value returned from the function is the fulfilled value of the promise returned by then().
                /// </param>
                /// <param name='onProgress' type='Function' optional='true' locid="WinJS.PromiseStateMachine.done_p:onProgress">
                /// the function to be called if the promise reports progress. Data about the progress
                /// is passed as the single argument. Promises are not required to support
                /// progress.
                /// </param>
                /// </signature>
                if (!onComplete) { return; }
                try {
                    var result = onComplete(this._value);
                    if (result && typeof result === "object" && typeof result.done === "function") {
                        result.done();
                    }
                } catch (ex) {
                    // force the exception to be thrown asynchronously to avoid any try/catch blocks
                    Promise._doneHandler(ex);
                }
            },
            then: function CompletePromise_then(onComplete) {
                /// <signature helpKeyword="WinJS.PromiseStateMachine.then">
                /// <summary locid="WinJS.PromiseStateMachine.then">
                /// Allows you to specify the work to be done on the fulfillment of the promised value,
                /// the error handling to be performed if the promise fails to fulfill
                /// a value, and the handling of progress notifications along the way.
                /// </summary>
                /// <param name='onComplete' type='Function' locid="WinJS.PromiseStateMachine.then_p:onComplete">
                /// The function to be called if the promise is fulfilled successfully with a value.
                /// The value is passed as the single argument. If the value is null, the value is returned.
                /// The value returned from the function becomes the fulfilled value of the promise returned by
                /// then(). If an exception is thrown while this function is being executed, the promise returned
                /// by then() moves into the error state.
                /// </param>
                /// <param name='onError' type='Function' optional='true' locid="WinJS.PromiseStateMachine.then_p:onError">
                /// The function to be called if the promise is fulfilled with an error. The error
                /// is passed as the single argument. If it is null, the error is forwarded.
                /// The value returned from the function becomes the fulfilled value of the promise returned by then().
                /// </param>
                /// <param name='onProgress' type='Function' optional='true' locid="WinJS.PromiseStateMachine.then_p:onProgress">
                /// The function to be called if the promise reports progress. Data about the progress
                /// is passed as the single argument. Promises are not required to support
                /// progress.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.PromiseStateMachine.then_returnValue">
                /// The promise whose value is the result of executing the complete or
                /// error function.
                /// </returns>
                /// </signature>
                try {
                    // If the value returned from the completion handler is the same as the value
                    // provided to the completion handler then there is no need for a new promise.
                    //
                    var newValue = onComplete ? onComplete(this._value) : this._value;
                    return newValue === this._value ? this : new CompletePromise(newValue);
                } catch (ex) {
                    return new ExceptionPromise(ex);
                }
            }
        }, {
            supportedForProcessing: false
        }
    );

    //
    // Promise is the user-creatable WinJS.Promise object.
    //

    function timeout(timeoutMS) {
        var id;
        return new Promise(
            function (c) {
                if (timeoutMS) {
                    id = _Global.setTimeout(c, timeoutMS);
                } else {
                    _BaseCoreUtils._setImmediate(c);
                }
            },
            function () {
                if (id) {
                    _Global.clearTimeout(id);
                }
            }
        );
    }

    function timeoutWithPromise(timeout, promise) {
        var cancelPromise = function () { promise.cancel(); };
        var cancelTimeout = function () { timeout.cancel(); };
        timeout.then(cancelPromise);
        promise.then(cancelTimeout, cancelTimeout);
        return promise;
    }

    var staticCanceledPromise;

    var Promise = _Base.Class.derive(PromiseStateMachine,
        function Promise_ctor(init, oncancel) {
            /// <signature helpKeyword="WinJS.Promise">
            /// <summary locid="WinJS.Promise">
            /// A promise provides a mechanism to schedule work to be done on a value that
            /// has not yet been computed. It is a convenient abstraction for managing
            /// interactions with asynchronous APIs.
            /// </summary>
            /// <param name="init" type="Function" locid="WinJS.Promise_p:init">
            /// The function that is called during construction of the  promise. The function
            /// is given three arguments (complete, error, progress). Inside this function
            /// you should add event listeners for the notifications supported by this value.
            /// </param>
            /// <param name="oncancel" optional="true" locid="WinJS.Promise_p:oncancel">
            /// The function to call if a consumer of this promise wants
            /// to cancel its undone work. Promises are not required to
            /// support cancellation.
            /// </param>
            /// </signature>

            if (tagWithStack && (tagWithStack === true || (tagWithStack & tag.promise))) {
                this._stack = Promise._getStack();
            }

            this._oncancel = oncancel;
            this._setState(state_created);
            this._run();

            try {
                var complete = this._completed.bind(this);
                var error = this._error.bind(this);
                var progress = this._progress.bind(this);
                init(complete, error, progress);
            } catch (ex) {
                this._setExceptionValue(ex);
            }
        }, {
            _oncancel: null,

            _cancelAction: function () {
                if (this._oncancel) {
                    try { this._oncancel(); } catch (ex) { }
                }
            },
            _cleanupAction: function () { this._oncancel = null; }
        }, {

            addEventListener: function Promise_addEventListener(eventType, listener, capture) {
                /// <signature helpKeyword="WinJS.Promise.addEventListener">
                /// <summary locid="WinJS.Promise.addEventListener">
                /// Adds an event listener to the control.
                /// </summary>
                /// <param name="eventType" locid="WinJS.Promise.addEventListener_p:eventType">
                /// The type (name) of the event.
                /// </param>
                /// <param name="listener" locid="WinJS.Promise.addEventListener_p:listener">
                /// The listener to invoke when the event is raised.
                /// </param>
                /// <param name="capture" locid="WinJS.Promise.addEventListener_p:capture">
                /// Specifies whether or not to initiate capture.
                /// </param>
                /// </signature>
                promiseEventListeners.addEventListener(eventType, listener, capture);
            },
            any: function Promise_any(values) {
                /// <signature helpKeyword="WinJS.Promise.any">
                /// <summary locid="WinJS.Promise.any">
                /// Returns a promise that is fulfilled when one of the input promises
                /// has been fulfilled.
                /// </summary>
                /// <param name="values" type="Array" locid="WinJS.Promise.any_p:values">
                /// An array that contains promise objects or objects whose property
                /// values include promise objects.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.any_returnValue">
                /// A promise that on fulfillment yields the value of the input (complete or error).
                /// </returns>
                /// </signature>
                return new Promise(
                    function (complete, error) {
                        var keys = Object.keys(values);
                        if (keys.length === 0) {
                            complete();
                        }
                        var canceled = 0;
                        keys.forEach(function (key) {
                            Promise.as(values[key]).then(
                                function () { complete({ key: key, value: values[key] }); },
                                function (e) {
                                    if (e instanceof Error && e.name === canceledName) {
                                        if ((++canceled) === keys.length) {
                                            complete(Promise.cancel);
                                        }
                                        return;
                                    }
                                    error({ key: key, value: values[key] });
                                }
                            );
                        });
                    },
                    function () {
                        var keys = Object.keys(values);
                        keys.forEach(function (key) {
                            var promise = Promise.as(values[key]);
                            if (typeof promise.cancel === "function") {
                                promise.cancel();
                            }
                        });
                    }
                );
            },
            as: function Promise_as(value) {
                /// <signature helpKeyword="WinJS.Promise.as">
                /// <summary locid="WinJS.Promise.as">
                /// Returns a promise. If the object is already a promise it is returned;
                /// otherwise the object is wrapped in a promise.
                /// </summary>
                /// <param name="value" locid="WinJS.Promise.as_p:value">
                /// The value to be treated as a promise.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.as_returnValue">
                /// A promise.
                /// </returns>
                /// </signature>
                if (value && typeof value === "object" && typeof value.then === "function") {
                    return value;
                }
                return new CompletePromise(value);
            },
            /// <field type="WinJS.Promise" helpKeyword="WinJS.Promise.cancel" locid="WinJS.Promise.cancel">
            /// Canceled promise value, can be returned from a promise completion handler
            /// to indicate cancelation of the promise chain.
            /// </field>
            cancel: {
                get: function () {
                    return (staticCanceledPromise = staticCanceledPromise || new ErrorPromise(new _ErrorFromName(canceledName)));
                }
            },
            dispatchEvent: function Promise_dispatchEvent(eventType, details) {
                /// <signature helpKeyword="WinJS.Promise.dispatchEvent">
                /// <summary locid="WinJS.Promise.dispatchEvent">
                /// Raises an event of the specified type and properties.
                /// </summary>
                /// <param name="eventType" locid="WinJS.Promise.dispatchEvent_p:eventType">
                /// The type (name) of the event.
                /// </param>
                /// <param name="details" locid="WinJS.Promise.dispatchEvent_p:details">
                /// The set of additional properties to be attached to the event object.
                /// </param>
                /// <returns type="Boolean" locid="WinJS.Promise.dispatchEvent_returnValue">
                /// Specifies whether preventDefault was called on the event.
                /// </returns>
                /// </signature>
                return promiseEventListeners.dispatchEvent(eventType, details);
            },
            is: function Promise_is(value) {
                /// <signature helpKeyword="WinJS.Promise.is">
                /// <summary locid="WinJS.Promise.is">
                /// Determines whether a value fulfills the promise contract.
                /// </summary>
                /// <param name="value" locid="WinJS.Promise.is_p:value">
                /// A value that may be a promise.
                /// </param>
                /// <returns type="Boolean" locid="WinJS.Promise.is_returnValue">
                /// true if the specified value is a promise, otherwise false.
                /// </returns>
                /// </signature>
                return value && typeof value === "object" && typeof value.then === "function";
            },
            join: function Promise_join(values) {
                /// <signature helpKeyword="WinJS.Promise.join">
                /// <summary locid="WinJS.Promise.join">
                /// Creates a promise that is fulfilled when all the values are fulfilled.
                /// </summary>
                /// <param name="values" type="Object" locid="WinJS.Promise.join_p:values">
                /// An object whose fields contain values, some of which may be promises.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.join_returnValue">
                /// A promise whose value is an object with the same field names as those of the object in the values parameter, where
                /// each field value is the fulfilled value of a promise.
                /// </returns>
                /// </signature>
                return new Promise(
                    function (complete, error, progress) {
                        var keys = Object.keys(values);
                        var errors = Array.isArray(values) ? [] : {};
                        var results = Array.isArray(values) ? [] : {};
                        var undefineds = 0;
                        var pending = keys.length;
                        var argDone = function (key) {
                            if ((--pending) === 0) {
                                var errorCount = Object.keys(errors).length;
                                if (errorCount === 0) {
                                    complete(results);
                                } else {
                                    var canceledCount = 0;
                                    keys.forEach(function (key) {
                                        var e = errors[key];
                                        if (e instanceof Error && e.name === canceledName) {
                                            canceledCount++;
                                        }
                                    });
                                    if (canceledCount === errorCount) {
                                        complete(Promise.cancel);
                                    } else {
                                        error(errors);
                                    }
                                }
                            } else {
                                progress({ Key: key, Done: true });
                            }
                        };
                        keys.forEach(function (key) {
                            var value = values[key];
                            if (value === undefined) {
                                undefineds++;
                            } else {
                                Promise.then(value,
                                    function (value) { results[key] = value; argDone(key); },
                                    function (value) { errors[key] = value; argDone(key); }
                                );
                            }
                        });
                        pending -= undefineds;
                        if (pending === 0) {
                            complete(results);
                            return;
                        }
                    },
                    function () {
                        Object.keys(values).forEach(function (key) {
                            var promise = Promise.as(values[key]);
                            if (typeof promise.cancel === "function") {
                                promise.cancel();
                            }
                        });
                    }
                );
            },
            removeEventListener: function Promise_removeEventListener(eventType, listener, capture) {
                /// <signature helpKeyword="WinJS.Promise.removeEventListener">
                /// <summary locid="WinJS.Promise.removeEventListener">
                /// Removes an event listener from the control.
                /// </summary>
                /// <param name='eventType' locid="WinJS.Promise.removeEventListener_eventType">
                /// The type (name) of the event.
                /// </param>
                /// <param name='listener' locid="WinJS.Promise.removeEventListener_listener">
                /// The listener to remove.
                /// </param>
                /// <param name='capture' locid="WinJS.Promise.removeEventListener_capture">
                /// Specifies whether or not to initiate capture.
                /// </param>
                /// </signature>
                promiseEventListeners.removeEventListener(eventType, listener, capture);
            },
            supportedForProcessing: false,
            then: function Promise_then(value, onComplete, onError, onProgress) {
                /// <signature helpKeyword="WinJS.Promise.then">
                /// <summary locid="WinJS.Promise.then">
                /// A static version of the promise instance method then().
                /// </summary>
                /// <param name="value" locid="WinJS.Promise.then_p:value">
                /// the value to be treated as a promise.
                /// </param>
                /// <param name="onComplete" type="Function" locid="WinJS.Promise.then_p:complete">
                /// The function to be called if the promise is fulfilled with a value.
                /// If it is null, the promise simply
                /// returns the value. The value is passed as the single argument.
                /// </param>
                /// <param name="onError" type="Function" optional="true" locid="WinJS.Promise.then_p:error">
                /// The function to be called if the promise is fulfilled with an error. The error
                /// is passed as the single argument.
                /// </param>
                /// <param name="onProgress" type="Function" optional="true" locid="WinJS.Promise.then_p:progress">
                /// The function to be called if the promise reports progress. Data about the progress
                /// is passed as the single argument. Promises are not required to support
                /// progress.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.then_returnValue">
                /// A promise whose value is the result of executing the provided complete function.
                /// </returns>
                /// </signature>
                return Promise.as(value).then(onComplete, onError, onProgress);
            },
            thenEach: function Promise_thenEach(values, onComplete, onError, onProgress) {
                /// <signature helpKeyword="WinJS.Promise.thenEach">
                /// <summary locid="WinJS.Promise.thenEach">
                /// Performs an operation on all the input promises and returns a promise
                /// that has the shape of the input and contains the result of the operation
                /// that has been performed on each input.
                /// </summary>
                /// <param name="values" locid="WinJS.Promise.thenEach_p:values">
                /// A set of values (which could be either an array or an object) of which some or all are promises.
                /// </param>
                /// <param name="onComplete" type="Function" locid="WinJS.Promise.thenEach_p:complete">
                /// The function to be called if the promise is fulfilled with a value.
                /// If the value is null, the promise returns the value.
                /// The value is passed as the single argument.
                /// </param>
                /// <param name="onError" type="Function" optional="true" locid="WinJS.Promise.thenEach_p:error">
                /// The function to be called if the promise is fulfilled with an error. The error
                /// is passed as the single argument.
                /// </param>
                /// <param name="onProgress" type="Function" optional="true" locid="WinJS.Promise.thenEach_p:progress">
                /// The function to be called if the promise reports progress. Data about the progress
                /// is passed as the single argument. Promises are not required to support
                /// progress.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.thenEach_returnValue">
                /// A promise that is the result of calling Promise.join on the values parameter.
                /// </returns>
                /// </signature>
                var result = Array.isArray(values) ? [] : {};
                Object.keys(values).forEach(function (key) {
                    result[key] = Promise.as(values[key]).then(onComplete, onError, onProgress);
                });
                return Promise.join(result);
            },
            timeout: function Promise_timeout(time, promise) {
                /// <signature helpKeyword="WinJS.Promise.timeout">
                /// <summary locid="WinJS.Promise.timeout">
                /// Creates a promise that is fulfilled after a timeout.
                /// </summary>
                /// <param name="timeout" type="Number" optional="true" locid="WinJS.Promise.timeout_p:timeout">
                /// The timeout period in milliseconds. If this value is zero or not specified
                /// setImmediate is called, otherwise setTimeout is called.
                /// </param>
                /// <param name="promise" type="Promise" optional="true" locid="WinJS.Promise.timeout_p:promise">
                /// A promise that will be canceled if it doesn't complete before the
                /// timeout has expired.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.timeout_returnValue">
                /// A promise that is completed asynchronously after the specified timeout.
                /// </returns>
                /// </signature>
                var to = timeout(time);
                return promise ? timeoutWithPromise(to, promise) : to;
            },
            wrap: function Promise_wrap(value) {
                /// <signature helpKeyword="WinJS.Promise.wrap">
                /// <summary locid="WinJS.Promise.wrap">
                /// Wraps a non-promise value in a promise. You can use this function if you need
                /// to pass a value to a function that requires a promise.
                /// </summary>
                /// <param name="value" locid="WinJS.Promise.wrap_p:value">
                /// Some non-promise value to be wrapped in a promise.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.wrap_returnValue">
                /// A promise that is successfully fulfilled with the specified value
                /// </returns>
                /// </signature>
                return new CompletePromise(value);
            },
            wrapError: function Promise_wrapError(error) {
                /// <signature helpKeyword="WinJS.Promise.wrapError">
                /// <summary locid="WinJS.Promise.wrapError">
                /// Wraps a non-promise error value in a promise. You can use this function if you need
                /// to pass an error to a function that requires a promise.
                /// </summary>
                /// <param name="error" locid="WinJS.Promise.wrapError_p:error">
                /// A non-promise error value to be wrapped in a promise.
                /// </param>
                /// <returns type="WinJS.Promise" locid="WinJS.Promise.wrapError_returnValue">
                /// A promise that is in an error state with the specified value.
                /// </returns>
                /// </signature>
                return new ErrorPromise(error);
            },

            _veryExpensiveTagWithStack: {
                get: function () { return tagWithStack; },
                set: function (value) { tagWithStack = value; }
            },
            _veryExpensiveTagWithStack_tag: tag,
            _getStack: function () {
                if (_Global.Debug && _Global.Debug.debuggerEnabled) {
                    try { throw new Error(); } catch (e) { return e.stack; }
                }
            },

            _cancelBlocker: function Promise__cancelBlocker(input) {
                //
                // Returns a promise which on cancelation will still result in downstream cancelation while
                //  protecting the promise 'input' from being  canceled which has the effect of allowing 
                //  'input' to be shared amoung various consumers.
                //
                if (!Promise.is(input)) {
                    return Promise.wrap(input);
                }
                var complete;
                var error;
                var output = new Promise(
                    function (c, e) {
                        complete = c;
                        error = e;
                    },
                    function () {
                        complete = null;
                        error = null;
                    }
                );
                input.then(
                    function (v) { complete && complete(v); },
                    function (e) { error && error(e); }
                );
                return output;
            },

        }
    );
    Object.defineProperties(Promise, _Events.createEventProperties(errorET));

    Promise._doneHandler = function(value) {
        _BaseCoreUtils._setImmediate(function Promise_done_rethrow() {
            throw value;
        });
    };

    return {
        PromiseStateMachine: PromiseStateMachine,
        Promise: Promise,
        state_created: state_created
    };
});

// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Promise',[
    './Core/_Base',
    './Promise/_StateMachine'
    ], function promiseInit( _Base, _StateMachine) {
    "use strict";

    _Base.Namespace.define("WinJS", {
        Promise: _StateMachine.Promise
    });

    return _StateMachine.Promise;
});


// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Scheduler',[
    'exports',
    './Core/_Global',
    './Core/_Base',
    './Core/_ErrorFromName',
    './Core/_Log',
    './Core/_Resources',
    './Core/_Trace',
    './Core/_WriteProfilerMark',
    './Promise'
    ], function schedulerInit(exports, _Global, _Base, _ErrorFromName, _Log, _Resources, _Trace, _WriteProfilerMark, Promise) {
    "use strict";

    function linkedListMixin(name) {
        var mixin = {};
        var PREV = "_prev" + name;
        var NEXT = "_next" + name;
        mixin["_remove" + name] = function () {
            // Assumes we always have a static head and tail.
            //
            var prev = this[PREV];
            var next = this[NEXT];
            // PREV <-> NEXT
            //
            next && (next[PREV] = prev);
            prev && (prev[NEXT] = next);
            // null <- this -> null
            //
            this[PREV] = null;
            this[NEXT] = null;
        };
        mixin["_insert" + name + "Before"] = function (node) {
            var prev = this[PREV];
            // PREV -> node -> this
            //
            prev && (prev[NEXT] = node);
            node[NEXT] = this;
            // PREV <- node <- this
            //
            node[PREV] = prev;
            this[PREV] = node;

            return node;
        };
        mixin["_insert" + name + "After"] = function (node) {
            var next = this[NEXT];
            // this -> node -> NEXT
            //
            this[NEXT] = node;
            node[NEXT] = next;
            // this <- node <- NEXT
            //
            node[PREV] = this;
            next && (next[PREV] = node);

            return node;
        };
        return mixin;
    }

    _Base.Namespace.define("WinJS.Utilities", {

        _linkedListMixin: linkedListMixin

    });

    var strings = {
        get jobInfoIsNoLongerValid() { return _Resources._getWinJSString("base/jobInfoIsNoLongerValid").value; }
    };

    //
    // Profiler mark helpers
    //
    // markerType must be one of the following: info, StartTM, StopTM
    //

    function profilerMarkArgs(arg0, arg1, arg2) {
        if (arg2 !== undefined) {
            return "(" + arg0 + ";" + arg1 + ";" + arg2 + ")";
        } else if (arg1 !== undefined) {
            return "(" + arg0 + ";" + arg1 + ")";
        } else if (arg0 !== undefined) {
            return "(" + arg0 + ")";
        } else {
            return "";
        }
    }

    function schedulerProfilerMark(operation, markerType, arg0, arg1) {
        _WriteProfilerMark(
            "WinJS.Scheduler:" + operation +
            profilerMarkArgs(arg0, arg1) +
            "," + markerType
        );
    }

    function jobProfilerMark(job, operation, markerType, arg0, arg1) {
        var argProvided = job.name || arg0 !== undefined || arg1 !== undefined;

        _WriteProfilerMark(
            "WinJS.Scheduler:" + operation + ":" + job.id +
            (argProvided ? profilerMarkArgs(job.name, arg0, arg1) : "") +
            "," + markerType
        );
    }

    //
    // Job type. This cannot be instantiated by developers and is instead handed back by the scheduler
    //  schedule method. Its public interface is what is used when interacting with a job.
    //

    var JobNode = _Base.Class.define(function (id, work, priority, context, name, asyncOpID) {
        this._id = id;
        this._work = work;
        this._context = context;
        this._name = name;
        this._asyncOpID = asyncOpID;
        this._setPriority(priority);
        this._setState(state_created);
        jobProfilerMark(this, "job-scheduled", "info");
    }, {

        /// <field type="Boolean" locid="WinJS.Utilities.Scheduler._JobNode.completed" helpKeyword="WinJS.Utilities.Scheduler._JobNode.completed">
        /// Gets a value that indicates whether the job has completed. This value is true if job has run to completion
        /// and false if it hasn't yet run or was canceled. 
        /// </field>
        completed: {
            get: function () { return !!this._state.completed; }
        },

        /// <field type="Number" locid="WinJS.Utilities.Scheduler._JobNode.id" helpKeyword="WinJS.Utilities.Scheduler._JobNode.id">
        /// Gets the unique identifier for this job.
        /// </field>
        id: {
            get: function () { return this._id; }
        },

        /// <field type="String" locid="WinJS.Utilities.Scheduler._JobNode.name" helpKeyword="WinJS.Utilities.Scheduler._JobNode.name">
        /// Gets or sets a string that specifies the diagnostic name for this job.
        /// </field>
        name: {
            get: function () { return this._name; },
            set: function (value) { this._name = value; }
        },

        /// <field type="WinJS.Utilities.Scheduler._OwnerToken" locid="WinJS.Utilities.Scheduler._JobNode.owner" helpKeyword="WinJS.Utilities.Scheduler._JobNode.owner">
        /// Gets an owner token for the job. You can use this owner token's cancelAll method to cancel related jobs. 
        /// </field>
        owner: {
            get: function () { return this._owner; },
            set: function (value) {
                this._owner && this._owner._remove(this);
                this._owner = value;
                this._owner && this._owner._add(this);
            }
        },

        /// <field type="WinJS.Utilities.Scheduler.Priority" locid="WinJS.Utilities.Scheduler._JobNode.priority" helpKeyword="WinJS.Utilities.Scheduler._JobNode.priority">
        /// Gets or sets the priority at which this job is executed by the scheduler.
        /// </field>
        priority: {
            get: function () { return this._priority; },
            set: function (value) {
                value = clampPriority(value);
                this._state.setPriority(this, value);
            }
        },

        cancel: function () {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler._JobNode.cancel">
            /// <summary locid="WinJS.Utilities.Scheduler._JobNode.cancel">Cancels the job.</summary>
            /// </signature>
            this._state.cancel(this);
        },

        pause: function () {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler._JobNode.pause">
            /// <summary locid="WinJS.Utilities.Scheduler._JobNode.pause">Pauses the job.</summary>
            /// </signature>
            this._state.pause(this);
        },

        resume: function () {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler._JobNode.resume">
            /// <summary locid="WinJS.Utilities.Scheduler._JobNode.resume">Resumes the job if it's been paused.</summary>
            /// </signature>
            this._state.resume(this);
        },

        _execute: function (shouldYield) {
            this._state.execute(this, shouldYield);
        },

        _executeDone: function (result) {
            return this._state.executeDone(this, result);
        },

        _blockedDone: function (result) {
            return this._state.blockedDone(this, result);
        },

        _setPriority: function (value) {
            if (+this._priority === this._priority && this._priority !== value) {
                jobProfilerMark(this, "job-priority-changed", "info",
                    markerFromPriority(this._priority).name,
                    markerFromPriority(value).name);
            }
            this._priority = value;
        },

        _setState: function (state, arg0, arg1) {
            if (this._state) {
                _Log.log && _Log.log("Transitioning job (" + this.id + ") from: " + this._state.name + " to: " + state.name, "winjs scheduler", "log");
            }
            this._state = state;
            this._state.enter(this, arg0, arg1);
        },

    });
    _Base.Class.mix(JobNode, linkedListMixin("Job"));

    var YieldPolicy = {
        complete: 1,
        continue: 2,
        block: 3,
    };

    //
    // JobInfo object is passed to a work item when it is executed and allows the work to ask whether it
    //  should cooperatively yield and in that event provide a continuation work function to run the
    //  next time this job is scheduled. The JobInfo object additionally allows access to the job itself
    //  and the ability to provide a Promise for a future continuation work function in order to have
    //  jobs easily block on async work.
    //

    var JobInfo = _Base.Class.define(function (shouldYield, job) {
        this._job = job;
        this._result = null;
        this._yieldPolicy = YieldPolicy.complete;
        this._shouldYield = shouldYield;
    }, {

        /// <field type="WinJS.Utilities.Scheduler._JobNode" locid="WinJS.Utilities.Scheduler._JobInfo.job" helpKeyword="WinJS.Utilities.Scheduler._JobInfo.job">
        /// The job instance for which the work is currently being executed.
        /// </field>
        job: {
            get: function () {
                this._throwIfDisabled();
                return this._job;
            }
        },

        /// <field type="Boolean" locid="WinJS.Utilities.Scheduler._JobInfo.shouldYield" helpKeyword="WinJS.Utilities.Scheduler._JobInfo.shouldYield">
        /// A boolean which will become true when the work item is requested to cooperatively yield by the scheduler.
        /// </field>
        shouldYield: {
            get: function () {
                this._throwIfDisabled();
                return this._shouldYield();
            }
        },

        setPromise: function (promise) {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler._JobInfo.setPromise">
            /// <summary locid="WinJS.Utilities.Scheduler._JobInfo.setPromise">
            /// Called when the  work item is blocked on asynchronous work.
            /// The scheduler waits for the specified Promise to complete before rescheduling the job. 
            /// </summary>
            /// <param name="promise" type="WinJS.Promise" locid="WinJS.Utilities.Scheduler._JobInfo.setPromise_p:promise">
            /// A Promise value which, when completed, provides a work item function to be re-scheduled.
            /// </param>
            /// </signature>
            this._throwIfDisabled();
            this._result = promise;
            this._yieldPolicy = YieldPolicy.block;
        },

        setWork: function (work) {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler._JobInfo.setWork">
            /// <summary locid="WinJS.Utilities.Scheduler._JobInfo.setWork">
            /// Called  when the work item is cooperatively yielding to the scheduler and has more work to complete in the future.
            /// Use this method to schedule additonal work for when the work item is about to yield.
            /// </summary>
            /// <param name="work" type="Function" locid="WinJS.Utilities.Scheduler._JobInfo.setWork_p:work">
            /// The work function which will be re-scheduled.
            /// </param>
            /// </signature>
            this._throwIfDisabled();
            this._result = work;
            this._yieldPolicy = YieldPolicy.continue;
        },

        _disablePublicApi: function () {
            // _disablePublicApi should be called as soon as the job yields. This
            //  says that the job info object should no longer be used by the
            //  job and if the job tries to use it, job info will throw.
            //
            this._publicApiDisabled = true;
        },

        _throwIfDisabled: function () {
            if (this._publicApiDisabled) {
                throw new _ErrorFromName("WinJS.Utilities.Scheduler.JobInfoIsNoLongerValid", strings.jobInfoIsNoLongerValid);
            }
        }

    });

    //
    // Owner type. Made available to developers through the createOwnerToken method.
    //  Allows cancelation of jobs in bulk.
    //

    var OwnerToken = _Base.Class.define(function OwnerToken_ctor() {
        this._jobs = {};
    }, {
        cancelAll: function OwnerToken_cancelAll() {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler._OwnerToken.cancelAll">
            /// <summary locid="WinJS.Utilities.Scheduler._OwnerToken.cancelAll">
            /// Cancels all jobs that are associated with this owner token.
            /// </summary>
            /// </signature>
            var jobs = this._jobs,
                jobIds = Object.keys(jobs);
            this._jobs = {};

            for (var i = 0, len = jobIds.length; i < len; i++) {
                jobs[jobIds[i]].cancel();
            }
        },

        _add: function OwnerToken_add(job) {
            this._jobs[job.id] = job;
        },

        _remove: function OwnerToken_remove(job) {
            delete this._jobs[job.id];
        }
    });

    function _() {
        // Noop function, used in the various states to indicate that they don't support a given
        // message. Named with the somewhat cute name '_' because it reads really well in the states.
        //
        return false;
    }
    function illegal(job) {
        /*jshint validthis: true */
        throw "Illegal call by job(" + job.id + ") in state: " + this.name;
    }

    //
    // Scheduler job state machine.
    //
    // A job normally goes through a lifecycle which is created -> scheduled -> running -> complete. The
    //  Scheduler decides when to transition a job from scheduled to running based on its policies and
    //  the other work which is scheduled.
    //
    // Additionally there are various operations which can be performed on a job which will change its
    //  state like: cancel, pause, resume and setting the job's priority.
    //
    // Additionally when in the running state a job may either cooperatively yield, or block.
    //
    // The job state machine accounts for these various states and interactions.
    //

    var State = _Base.Class.define(function (name) {
        this.name = name;
        this.enter = illegal;
        this.execute = illegal;
        this.executeDone = illegal;
        this.blockedDone = illegal;
        this.cancel = illegal;
        this.pause = illegal;
        this.resume = illegal;
        this.setPriority = illegal;
    });

    var state_created = new State("created"),                                   // -> scheduled
        state_scheduled = new State("scheduled"),                               // -> running | canceled | paused
        state_paused = new State("paused"),                                     // -> canceled | scheduled
        state_canceled = new State("canceled"),                                 // -> .
        state_running = new State("running"),                                   // -> cooperative_yield | blocked | complete | running_canceled | running_paused
        state_running_paused = new State("running_paused"),                     // -> cooperative_yield_paused | blocked_paused | complete | running_canceled | running_resumed
        state_running_resumed = new State("running_resumed"),                   // -> cooperative_yield | blocked | complete | running_canceled | running_paused
        state_running_canceled = new State("running_canceled"),                 // -> canceled | running_canceled_blocked
        state_running_canceled_blocked = new State("running_canceled_blocked"), // -> canceled
        state_cooperative_yield = new State("cooperative_yield"),               // -> scheduled
        state_cooperative_yield_paused = new State("cooperative_yield_paused"), // -> paused
        state_blocked = new State("blocked"),                                   // -> blocked_waiting
        state_blocked_waiting = new State("blocked_waiting"),                   // -> cooperative_yield | complete | blocked_canceled | blocked_paused_waiting
        state_blocked_paused = new State("blocked_paused"),                     // -> blocked_paused_waiting
        state_blocked_paused_waiting = new State("blocked_paused_waiting"),     // -> cooperative_yield_paused | complete | blocked_canceled | blocked_waiting
        state_blocked_canceled = new State("blocked_canceled"),                 // -> canceled
        state_complete = new State("complete");                                 // -> .

    // A given state may include implementations for the following operations:
    //
    //  - enter(job, arg0, arg1)
    //  - execute(job, shouldYield)
    //  - executeDone(job, result) --> next state
    //  - blockedDone(job, result, initialPriority)
    //  - cancel(job)
    //  - pause(job)
    //  - resume(job)
    //  - setPriority(job, priority)
    //
    // Any functions which are not implemented are illegal in that state.
    // Any functions which have an implementation of _ are a nop in that state.
    //

    // Helper which yields a function that transitions to the specified state
    //
    function setState(state) {
        return function (job, arg0, arg1) {
            job._setState(state, arg0, arg1);
        };
    }

    // Helper which sets the priority of a job.
    //
    function changePriority(job, priority) {
        job._setPriority(priority);
    }

    // Created
    //
    state_created.enter = function (job) {
        addJobAtTailOfPriority(job, job.priority);
        job._setState(state_scheduled);
    };

    // Scheduled
    //
    state_scheduled.enter = function () {
        startRunning();
    };
    state_scheduled.execute = setState(state_running);
    state_scheduled.cancel = setState(state_canceled);
    state_scheduled.pause = setState(state_paused);
    state_scheduled.resume = _;
    state_scheduled.setPriority = function (job, priority) {
        if (job.priority !== priority) {
            job._setPriority(priority);
            job.pause();
            job.resume();
        }
    };

    // Paused
    //
    state_paused.enter = function (job) {
        jobProfilerMark(job, "job-paused", "info");
        job._removeJob();
    };
    state_paused.cancel = setState(state_canceled);
    state_paused.pause = _;
    state_paused.resume = function (job) {
        jobProfilerMark(job, "job-resumed", "info");
        addJobAtTailOfPriority(job, job.priority);
        job._setState(state_scheduled);
    };
    state_paused.setPriority = changePriority;

    // Canceled
    //
    state_canceled.enter = function (job) {
        jobProfilerMark(job, "job-canceled", "info");
        _Trace._traceAsyncOperationCompleted(job._asyncOpID, _Global.Debug && _Global.Debug.MS_ASYNC_OP_STATUS_CANCELED);
        job._removeJob();
        job._work = null;
        job._context = null;
        job.owner = null;
    };
    state_canceled.cancel = _;
    state_canceled.pause = _;
    state_canceled.resume = _;
    state_canceled.setPriority = _;

    // Running
    //
    state_running.enter = function (job, shouldYield) {
        // Remove the job from the list in case it throws an exception, this means in the 
        //  yield case we have to add it back.
        //
        job._removeJob();

        var priority = job.priority;
        var work = job._work;
        var context = job._context;

        // Null out the work and context so they aren't leaked if the job throws an exception.
        //
        job._work = null;
        job._context = null;

        var jobInfo = new JobInfo(shouldYield, job);

        _Trace._traceAsyncCallbackStarting(job._asyncOpID);
        try {
            MSApp.execAtPriority(function () {
                work.call(context, jobInfo);
            }, toWwaPriority(priority));
        } finally {
            _Trace._traceAsyncCallbackCompleted();
            jobInfo._disablePublicApi();
        }

        // Restore the context in case it is needed due to yielding or blocking.
        //
        job._context = context;

        var targetState = job._executeDone(jobInfo._yieldPolicy);

        job._setState(targetState, jobInfo._result, priority);
    };
    state_running.executeDone = function (job, yieldPolicy) {
        switch (yieldPolicy) {
            case YieldPolicy.complete:
                return state_complete;
            case YieldPolicy.continue:
                return state_cooperative_yield;
            case YieldPolicy.block:
                return state_blocked;
        }
    };
    state_running.cancel = function (job) {
        // Interaction with the singleton scheduler. The act of canceling a job pokes the scheduler
        //  and tells it to start asking the job to yield.
        //
        immediateYield = true;
        job._setState(state_running_canceled);
    };
    state_running.pause = function (job) {
        // Interaction with the singleton scheduler. The act of pausing a job pokes the scheduler
        //  and tells it to start asking the job to yield.
        //
        immediateYield = true;
        job._setState(state_running_paused);
    };
    state_running.resume = _;
    state_running.setPriority = changePriority;

    // Running paused
    //
    state_running_paused.enter = _;
    state_running_paused.executeDone = function (job, yieldPolicy) {
        switch (yieldPolicy) {
            case YieldPolicy.complete:
                return state_complete;
            case YieldPolicy.continue:
                return state_cooperative_yield_paused;
            case YieldPolicy.block:
                return state_blocked_paused;
        }
    };
    state_running_paused.cancel = setState(state_running_canceled);
    state_running_paused.pause = _;
    state_running_paused.resume = setState(state_running_resumed);
    state_running_paused.setPriority = changePriority;

    // Running resumed
    //
    state_running_resumed.enter = _;
    state_running_resumed.executeDone = function (job, yieldPolicy) {
        switch (yieldPolicy) {
            case YieldPolicy.complete:
                return state_complete;
            case YieldPolicy.continue:
                return state_cooperative_yield;
            case YieldPolicy.block:
                return state_blocked;
        }
    };
    state_running_resumed.cancel = setState(state_running_canceled);
    state_running_resumed.pause = setState(state_running_paused);
    state_running_resumed.resume = _;
    state_running_resumed.setPriority = changePriority;

    // Running canceled
    //
    state_running_canceled.enter = _;
    state_running_canceled.executeDone = function (job, yieldPolicy) {
        switch (yieldPolicy) {
            case YieldPolicy.complete:
            case YieldPolicy.continue:
                return state_canceled;
            case YieldPolicy.block:
                return state_running_canceled_blocked;
        }
    };
    state_running_canceled.cancel = _;
    state_running_canceled.pause = _;
    state_running_canceled.resume = _;
    state_running_canceled.setPriority = _;

    // Running canceled -> blocked
    //
    state_running_canceled_blocked.enter = function (job, work) {
        work.cancel();
        job._setState(state_canceled);
    };

    // Cooperative yield
    //
    state_cooperative_yield.enter = function (job, work, initialPriority) {
        jobProfilerMark(job, "job-yielded", "info");
        if (initialPriority === job.priority) {
            addJobAtHeadOfPriority(job, job.priority);
        } else {
            addJobAtTailOfPriority(job, job.priority);
        }
        job._work = work;
        job._setState(state_scheduled);
    };

    // Cooperative yield paused
    //
    state_cooperative_yield_paused.enter = function (job, work) {
        jobProfilerMark(job, "job-yielded", "info");
        job._work = work;
        job._setState(state_paused);
    };

    // Blocked
    //
    state_blocked.enter = function (job, work, initialPriority) {
        jobProfilerMark(job, "job-blocked", "StartTM");
        job._work = work;
        job._setState(state_blocked_waiting);

        // Sign up for a completion from the provided promise, after the completion occurs
        //  transition from the current state at the completion time to the target state
        //  depending on the completion value.
        //
        work.done(
            function (newWork) {
                jobProfilerMark(job, "job-blocked", "StopTM");
                var targetState = job._blockedDone(newWork);
                job._setState(targetState, newWork, initialPriority);
            },
            function (error) {
                if (!(error && error.name === "Canceled")) {
                    jobProfilerMark(job, "job-error", "info");
                }
                jobProfilerMark(job, "job-blocked", "StopTM");
                job._setState(state_canceled);
                return Promise.wrapError(error);
            }
        );
    };

    // Blocked waiting
    //
    state_blocked_waiting.enter = _;
    state_blocked_waiting.blockedDone = function (job, result) {
        if (typeof result === "function") {
            return state_cooperative_yield;
        } else {
            return state_complete;
        }
    };
    state_blocked_waiting.cancel = setState(state_blocked_canceled);
    state_blocked_waiting.pause = setState(state_blocked_paused_waiting);
    state_blocked_waiting.resume = _;
    state_blocked_waiting.setPriority = changePriority;

    // Blocked paused
    //
    state_blocked_paused.enter = function (job, work, initialPriority) {
        jobProfilerMark(job, "job-blocked", "StartTM");
        job._work = work;
        job._setState(state_blocked_paused_waiting);

        // Sign up for a completion from the provided promise, after the completion occurs
        //  transition from the current state at the completion time to the target state
        //  depending on the completion value.
        //
        work.done(
            function (newWork) {
                jobProfilerMark(job, "job-blocked", "StopTM");
                var targetState = job._blockedDone(newWork);
                job._setState(targetState, newWork, initialPriority);
            },
            function (error) {
                if (!(error && error.name === "Canceled")) {
                    jobProfilerMark(job, "job-error", "info");
                }
                jobProfilerMark(job, "job-blocked", "StopTM");
                job._setState(state_canceled);
                return Promise.wrapError(error);
            }
        );
    };

    // Blocked paused waiting
    //
    state_blocked_paused_waiting.enter = _;
    state_blocked_paused_waiting.blockedDone = function (job, result) {
        if (typeof result === "function") {
            return state_cooperative_yield_paused;
        } else {
            return state_complete;
        }
    };
    state_blocked_paused_waiting.cancel = setState(state_blocked_canceled);
    state_blocked_paused_waiting.pause = _;
    state_blocked_paused_waiting.resume = setState(state_blocked_waiting);
    state_blocked_paused_waiting.setPriority = changePriority;

    // Blocked canceled
    //
    state_blocked_canceled.enter = function (job) {
        // Cancel the outstanding promise and then eventually it will complete, presumably with a 'canceled'
        //  error at which point we will transition to the canceled state.
        //
        job._work.cancel();
        job._work = null;
    };
    state_blocked_canceled.blockedDone = function () {
        return state_canceled;
    };
    state_blocked_canceled.cancel = _;
    state_blocked_canceled.pause = _;
    state_blocked_canceled.resume = _;
    state_blocked_canceled.setPriority = _;

    // Complete
    //
    state_complete.completed = true;
    state_complete.enter = function (job) {
        _Trace._traceAsyncOperationCompleted(job._asyncOpID, _Global.Debug && _Global.Debug.MS_ASYNC_OP_STATUS_SUCCESS);
        job._work = null;
        job._context = null;
        job.owner = null;
        jobProfilerMark(job, "job-completed", "info");
    };
    state_complete.cancel = _;
    state_complete.pause = _;
    state_complete.resume = _;
    state_complete.setPriority = _;

    // Private Priority marker node in the Job list. The marker nodes are linked both into the job
    //  list and a separate marker list. This is used so that jobs can be easily added into a given
    //  priority level by simply traversing to the next marker in the list and inserting before it.
    //
    // Markers may either be "static" or "dynamic". Static markers are the set of things which are 
    //  named and are always in the list, they may exist with or without jobs at their priority 
    //  level. Dynamic markers are added as needed.
    //
    // @NOTE: Dynamic markers are NYI
    //
    var MarkerNode = _Base.Class.define(function (priority, name) {
        this.priority = priority;
        this.name = name;
    }, {

        // NYI
        //
        //dynamic: {
        //    get: function () { return !this.name; }
        //},

    });
    _Base.Class.mix(MarkerNode, linkedListMixin("Job"), linkedListMixin("Marker"));

    //
    // Scheduler state
    //

    // Unique ID per job.
    //
    var globalJobId = 0;

    // Unique ID per drain request.
    var globalDrainId = 0;

    // Priority is: -15 ... 0 ... 15 where that maps to: 'min' ... 'normal' ... 'max'
    //
    var MIN_PRIORITY = -15;
    var MAX_PRIORITY = 15;

    // Named priorities
    //
    var Priority = {
        max: 15,
        high: 13,
        aboveNormal: 9,
        normal: 0,
        belowNormal: -9,
        idle: -13,
        min: -15,
    };

    // Definition of the priorities, named have static markers.
    //
    var priorities = [
        new MarkerNode(15, "max"),          // Priority.max
        new MarkerNode(14, "14"),
        new MarkerNode(13, "high"),         // Priority.high
        new MarkerNode(12, "12"),
        new MarkerNode(11, "11"),
        new MarkerNode(10, "10"),
        new MarkerNode(9, "aboveNormal"),   // Priority.aboveNormal
        new MarkerNode(8, "8"),
        new MarkerNode(7, "7"),
        new MarkerNode(6, "6"),
        new MarkerNode(5, "5"),
        new MarkerNode(4, "4"),
        new MarkerNode(3, "3"),
        new MarkerNode(2, "2"),
        new MarkerNode(1, "1"),
        new MarkerNode(0, "normal"),        // Priority.normal
        new MarkerNode(-1, "-1"),
        new MarkerNode(-2, "-2"),
        new MarkerNode(-3, "-3"),
        new MarkerNode(-4, "-4"),
        new MarkerNode(-5, "-5"),
        new MarkerNode(-6, "-6"),
        new MarkerNode(-7, "-7"),
        new MarkerNode(-8, "-8"),
        new MarkerNode(-9, "belowNormal"),  // Priority.belowNormal
        new MarkerNode(-10, "-10"),
        new MarkerNode(-11, "-11"),
        new MarkerNode(-12, "-12"),
        new MarkerNode(-13, "idle"),        // Priority.idle
        new MarkerNode(-14, "-14"),
        new MarkerNode(-15, "min"),         // Priority.min
        new MarkerNode(-16, "<TAIL>")
    ];

    function dumpList(type, reverse) {
        function dumpMarker(marker, pos) {
            _Log.log && _Log.log(pos + ": MARKER: " + marker.name, "winjs scheduler", "log");
        }
        function dumpJob(job, pos) {
            _Log.log && _Log.log(pos + ": JOB(" + job.id + "): state: " + (job._state ? job._state.name : "") + (job.name ? ", name: " + job.name : ""), "winjs scheduler", "log");
        }
        _Log.log && _Log.log("highWaterMark: " + highWaterMark, "winjs scheduler", "log");
        var pos = 0;
        var head = reverse ? priorities[priorities.length - 1] : priorities[0];
        var current = head;
        do {
            if (current instanceof MarkerNode) {
                dumpMarker(current, pos);
            }
            if (current instanceof JobNode) {
                dumpJob(current, pos);
            }
            pos++;
            current = reverse ? current["_prev" + type] : current["_next" + type];
        } while (current);
    }

    function retrieveState() {
        /// <signature helpKeyword="WinJS.Utilities.Scheduler.retrieveState">
        /// <summary locid="WinJS.Utilities.Scheduler.retrieveState">
        /// Returns a string representation of the scheduler's state for diagnostic
        /// purposes. The jobs and drain requests are displayed in the order in which
        /// they are currently expected to be processed. The current job and drain
        /// request are marked by an asterisk.
        /// </summary>
        /// </signature>
        var output = "";

        function logJob(job, isRunning) {
            output +=
                "    " + (isRunning ? "*" : " ") +
                "id: " + job.id +
                ", priority: " + markerFromPriority(job.priority).name +
                (job.name ? ", name: " + job.name : "") +
                "\n";
        }

        output += "Jobs:\n";
        var current = markerFromPriority(highWaterMark);
        var jobCount = 0;
        if (runningJob) {
            logJob(runningJob, true);
            jobCount++;
        }
        while (current.priority >= Priority.min) {
            if (current instanceof JobNode) {
                logJob(current, false);
                jobCount++;
            }
            current = current._nextJob;
        }
        if (jobCount === 0) {
            output += "     None\n";
        }

        output += "Drain requests:\n";
        for (var i = 0, len = drainQueue.length; i < len; i++) {
            output +=
                "    " + (i === 0 ? "*" : " ") +
                "priority: " + markerFromPriority(drainQueue[i].priority).name +
                ", name: " + drainQueue[i].name +
                "\n";
        }
        if (drainQueue.length === 0) {
            output += "     None\n";
        }

        return output;
    }

    function isEmpty() {
        var current = priorities[0];
        do {
            if (current instanceof JobNode) {
                return false;
            }
            current = current._nextJob;
        } while (current);

        return true;
    }

    // The WWA priority at which the pump is currently scheduled on the WWA scheduler.
    //  null when the pump is not scheduled.
    //
    var scheduledWwaPriority = null;

    // Whether the scheduler pump is currently on the stack
    //
    var pumping;
    // What priority is currently being pumped
    //
    var pumpingPriority;

    // A reference to the job object that is currently running.
    //  null when no job is running.
    //
    var runningJob = null;

    // Whether we are using the WWA scheduler.
    //
    var usingWwaScheduler = !!(_Global.MSApp && _Global.MSApp.execAtPriority);

    // Queue of drain listeners
    //
    var drainQueue = [];

    // Bit indicating that we should yield immediately
    //
    var immediateYield;

    // time slice for scheduler
    //
    var TIME_SLICE = 30;

    // high-water-mark is maintained any time priorities are adjusted, new jobs are 
    //  added or the scheduler pumps itself down through a priority marker. The goal
    //  of the high-water-mark is to be a fast check as to whether a job may exist
    //  at a higher priority level than we are currently at. It may be wrong but it
    //  may only be wrong by being higher than the current highest priority job, not
    //  lower as that would cause the system to pump things out of order.
    //
    var highWaterMark = Priority.min;

    //
    // Initialize the scheduler
    //

    // Wire up the markers
    //
    priorities.reduce(function (prev, current) {
        if (prev) {
            prev._insertJobAfter(current);
            prev._insertMarkerAfter(current);
        }
        return current;
    });

    //
    // Draining mechanism
    //
    // For each active drain request, there is a unique drain listener in the
    //  drainQueue. Requests are processed in FIFO order. The scheduler is in
    //  drain mode precisely when the drainQueue is non-empty.
    //

    // Returns priority of the current drain request
    //
    function currentDrainPriority() {
        return drainQueue.length === 0 ? null : drainQueue[0].priority;
    }

    function drainStarting(listener) {
        schedulerProfilerMark("drain", "StartTM", listener.name, markerFromPriority(listener.priority).name);
    }
    function drainStopping(listener, canceled) {
        if (canceled) {
            schedulerProfilerMark("drain-canceled", "info", listener.name, markerFromPriority(listener.priority).name);
        }
        schedulerProfilerMark("drain", "StopTM", listener.name, markerFromPriority(listener.priority).name);
    }

    function addDrainListener(priority, complete, name) {
        drainQueue.push({ priority: priority, complete: complete, name: name });
        if (drainQueue.length === 1) {
            drainStarting(drainQueue[0]);
            if (priority > highWaterMark) {
                highWaterMark = priority;
                immediateYield = true;
            }
        }
    }

    function removeDrainListener(complete, canceled) {
        var i,
            len = drainQueue.length;

        for (i = 0; i < len; i++) {
            if (drainQueue[i].complete === complete) {
                if (i === 0) {
                    drainStopping(drainQueue[0], canceled);
                    drainQueue[1] && drainStarting(drainQueue[1]);
                }
                drainQueue.splice(i, 1);
                break;
            }
        }
    }

    // Notifies and removes the current drain listener
    //
    function notifyCurrentDrainListener() {
        var listener = drainQueue.shift();

        if (listener) {
            drainStopping(listener);
            drainQueue[0] && drainStarting(drainQueue[0]);
            listener.complete();
        }
    }

    // Notifies all drain listeners which are at a priority > highWaterMark.
    //  Returns whether or not any drain listeners were notified. This
    //  function sets pumpingPriority and reads highWaterMark. Note that
    //  it may call into user code which may call back into the scheduler.
    //
    function notifyDrainListeners() {
        var notifiedSomebody = false;
        if (!!drainQueue.length) {
            // As we exhaust priority levels, notify the appropriate drain listeners.
            //
            var drainPriority = currentDrainPriority();
            while (+drainPriority === drainPriority && drainPriority > highWaterMark) {
                pumpingPriority = drainPriority;
                notifyCurrentDrainListener();
                notifiedSomebody = true;
                drainPriority = currentDrainPriority();
            }
        }
        return notifiedSomebody;
    }

    //
    // Interfacing with the WWA Scheduler
    //
    
    // The purpose of yielding to the host is to give the host the opportunity to do some work.
    // setImmediate has this guarantee built-in so we prefer that. Otherwise, we do setTimeout 16
    // which should give the host a decent amount of time to do work.
    //
    var scheduleWithHost = _Global.setImmediate ? _Global.setImmediate.bind(_Global) : function (callback) {
        _Global.setTimeout(callback, 16);
    };

    // Stubs for the parts of the WWA scheduler APIs that we use. These stubs are
    //  used in contexts where the WWA scheduler is not available.
    //
    var MSAppStubs = {
        execAsyncAtPriority: function (callback, priority) {
            // If it's a high priority callback then we additionally schedule using setTimeout(0)
            //
            if (priority === MSApp.HIGH) {
                _Global.setTimeout(callback, 0);
            }
            // We always schedule using setImmediate
            //
            scheduleWithHost(callback);
        },

        execAtPriority: function (callback) {
            return callback();
        },

        getCurrentPriority: function () {
            return MSAppStubs.NORMAL;
        },

        isTaskScheduledAtPriorityOrHigher: function () {
            return false;
        },

        HIGH: "high",
        NORMAL: "normal",
        IDLE: "idle"
    };

    var MSApp = (usingWwaScheduler ? _Global.MSApp : MSAppStubs);

    function toWwaPriority(winjsPriority) {
        if (winjsPriority >= Priority.aboveNormal + 1) { return MSApp.HIGH; }
        if (winjsPriority >= Priority.belowNormal) { return MSApp.NORMAL; }
        return MSApp.IDLE;
    }

    var wwaPriorityToInt = {};
    wwaPriorityToInt[MSApp.IDLE] = 1;
    wwaPriorityToInt[MSApp.NORMAL] = 2;
    wwaPriorityToInt[MSApp.HIGH] = 3;

    function isEqualOrHigherWwaPriority(priority1, priority2) {
        return wwaPriorityToInt[priority1] >= wwaPriorityToInt[priority2];
    }

    function isHigherWwaPriority(priority1, priority2) {
        return wwaPriorityToInt[priority1] > wwaPriorityToInt[priority2];
    }

    function wwaTaskScheduledAtPriorityHigherThan(wwaPriority) {
        switch (wwaPriority) {
            case MSApp.HIGH:
                return false;
            case MSApp.NORMAL:
                return MSApp.isTaskScheduledAtPriorityOrHigher(MSApp.HIGH);
            case MSApp.IDLE:
                return MSApp.isTaskScheduledAtPriorityOrHigher(MSApp.NORMAL);
        }
    }

    //
    // Mechanism for the scheduler
    //

    function addJobAtHeadOfPriority(node, priority) {
        var marker = markerFromPriority(priority);
        if (marker.priority > highWaterMark) {
            highWaterMark = marker.priority;
            immediateYield = true;
        }
        marker._insertJobAfter(node);
    }

    function addJobAtTailOfPriority(node, priority) {
        var marker = markerFromPriority(priority);
        if (marker.priority > highWaterMark) {
            highWaterMark = marker.priority;
            immediateYield = true;
        }
        marker._nextMarker._insertJobBefore(node);
    }

    function clampPriority(priority) {
        priority = priority | 0;
        priority = Math.max(priority, MIN_PRIORITY);
        priority = Math.min(priority, MAX_PRIORITY);
        return priority;
    }

    function markerFromPriority(priority) {
        priority = clampPriority(priority);

        // The priority skip list is from high -> idle, add the offset and then make it positive.
        //
        return priorities[-1 * (priority - MAX_PRIORITY)];
    }

    // Performance.now is not defined in web workers.
    //
    var now = (_Global.performance && _Global.performance.now.bind(_Global.performance)) || Date.now.bind(Date);

    // Main scheduler pump.
    //
    function run(scheduled) {
        pumping = true;
        schedulerProfilerMark("timeslice", "StartTM");
        var didWork;
        var ranJobSuccessfully = true;
        var current;
        var lastLoggedPriority;
        var timesliceExhausted = false;
        var yieldForPriorityBoundary = false;

        // Reset per-run state
        //
        immediateYield = false;

        try {
            var start = now();
            var end = start + TIME_SLICE;

            // Yielding policy
            //
            // @TODO, should we have a different scheduler policy when the debugger is attached. Today if you
            //  break in user code we will generally yield immediately after that job due to the fact that any
            //  breakpoint will take longer than TIME_SLICE to process.
            //
            
            var shouldYield = function () {
                timesliceExhausted = false;
                if (immediateYield) { return true; }
                if (wwaTaskScheduledAtPriorityHigherThan(toWwaPriority(highWaterMark))) { return true; }
                if (!!drainQueue.length) { return false; }
                if (now() > end) {
                    timesliceExhausted = true;
                    return true;
                }
                return false;
            };

            // Run until we run out of jobs or decide it is time to yield
            //
            while (highWaterMark >= Priority.min && !shouldYield() && !yieldForPriorityBoundary) {

                didWork = false;
                current = markerFromPriority(highWaterMark)._nextJob;
                do {
                    // Record the priority currently being pumped
                    //
                    pumpingPriority = current.priority;

                    if (current instanceof JobNode) {
                        if (lastLoggedPriority !== current.priority) {
                            if (+lastLoggedPriority === lastLoggedPriority) {
                                schedulerProfilerMark("priority", "StopTM", markerFromPriority(lastLoggedPriority).name);
                            }
                            schedulerProfilerMark("priority", "StartTM", markerFromPriority(current.priority).name);
                            lastLoggedPriority = current.priority;
                        }

                        // Important that we update this state before calling execute because the
                        //  job may throw an exception and we don't want to stall the queue.
                        //
                        didWork = true;
                        ranJobSuccessfully = false;
                        runningJob = current;
                        jobProfilerMark(runningJob, "job-running", "StartTM", markerFromPriority(pumpingPriority).name);
                        current._execute(shouldYield);
                        jobProfilerMark(runningJob, "job-running", "StopTM", markerFromPriority(pumpingPriority).name);
                        runningJob = null;
                        ranJobSuccessfully = true;
                    } else {
                        // As we pass marker nodes update our high water mark. It's important to do
                        //  this before notifying drain listeners because they may schedule new jobs
                        //  which will affect the highWaterMark.
                        //
                        var wwaPrevHighWaterMark = toWwaPriority(highWaterMark);
                        highWaterMark = current.priority;

                        didWork = notifyDrainListeners();

                        var wwaHighWaterMark = toWwaPriority(highWaterMark);
                        if (isHigherWwaPriority(wwaPrevHighWaterMark, wwaHighWaterMark) &&
                                (!usingWwaScheduler || MSApp.isTaskScheduledAtPriorityOrHigher(wwaHighWaterMark))) {
                            // Timeslice is moving to a lower WWA priority and the host
                            //  has equally or more important work to do. Time to yield.
                            //
                            yieldForPriorityBoundary = true;
                        }
                    }

                    current = current._nextJob;

                    // When didWork is true we exit the loop because:
                    //  - We've called into user code which may have modified the
                    //    scheduler's queue. We need to restart at the high water mark.
                    //  - We need to check if it's time for the scheduler to yield.
                    //
                } while (current && !didWork && !yieldForPriorityBoundary && !wwaTaskScheduledAtPriorityHigherThan(toWwaPriority(highWaterMark)));

                // Reset per-item state
                //
                immediateYield = false;

            }

        } finally {
            runningJob = null;

            // If a job was started and did not run to completion due to an exception
            //  we should transition it to a terminal state.
            //
            if (!ranJobSuccessfully) {
                jobProfilerMark(current, "job-error", "info");
                jobProfilerMark(current, "job-running", "StopTM", markerFromPriority(pumpingPriority).name);
                current.cancel();
            }

            if (+lastLoggedPriority === lastLoggedPriority) {
                schedulerProfilerMark("priority", "StopTM", markerFromPriority(lastLoggedPriority).name);
            }
            // Update high water mark to be the priority of the highest priority job.
            //
            var foundAJob = false;
            while (highWaterMark >= Priority.min && !foundAJob) {

                didWork = false;
                current = markerFromPriority(highWaterMark)._nextJob;
                do {

                    if (current instanceof JobNode) {
                        // We found a job. High water mark is now set to the priority
                        //  of this job.
                        //
                        foundAJob = true;
                    } else {
                        // As we pass marker nodes update our high water mark. It's important to do
                        //  this before notifying drain listeners because they may schedule new jobs
                        //  which will affect the highWaterMark.
                        //
                        highWaterMark = current.priority;

                        didWork = notifyDrainListeners();
                    }

                    current = current._nextJob;

                    // When didWork is true we exit the loop because:
                    //  - We've called into user code which may have modified the
                    //    scheduler's queue. We need to restart at the high water mark.
                    //
                } while (current && !didWork && !foundAJob);
            }

            var reasonForYielding;
            if (!ranJobSuccessfully) {
                reasonForYielding = "job error";
            } else if (timesliceExhausted) {
                reasonForYielding = "timeslice exhausted";
            } else if (highWaterMark < Priority.min) {
                reasonForYielding = "jobs exhausted";
            } else if (yieldForPriorityBoundary) {
                reasonForYielding = "reached WWA priority boundary";
            } else {
                reasonForYielding = "WWA host work";
            }

            // If this was a scheduled call to the pump, then the pump is no longer
            //  scheduled to be called and we should clear its scheduled priority.
            //
            if (scheduled) {
                scheduledWwaPriority = null;
            }

            // If the high water mark has not reached the end of the queue then
            //  we re-queue in order to see if there are more jobs to run.
            //
            pumping = false;
            if (highWaterMark >= Priority.min) {
                startRunning();
            }
            schedulerProfilerMark("yielding", "info", reasonForYielding);
            schedulerProfilerMark("timeslice", "StopTM");
        }
    }

    // When we schedule the pump we assign it a version. When we start executing one we check
    //  to see what the max executed version is. If we have superseded it then we skip the call.
    //
    var scheduledVersion = 0;
    var executedVersion = 0;

    function startRunning(priority) {
        if (+priority !== priority) {
            priority = highWaterMark;
        }
        var priorityWwa = toWwaPriority(priority);

        // Don't schedule the pump while pumping. The pump will be scheduled
        //  immediately before yielding if necessary.
        //
        if (pumping) {
            return;
        }

        // If the pump is already scheduled at priority or higher, then there
        //  is no need to schedule the pump again.
        // However, when we're not using the WWA scheduler, we fallback to immediate/timeout
        //  which do not have a notion of priority. In this case, if the pump is scheduled,
        //  there is no need to schedule another pump.
        //
        if (scheduledWwaPriority && (!usingWwaScheduler || isEqualOrHigherWwaPriority(scheduledWwaPriority, priorityWwa))) {
            return;
        }
        var current = ++scheduledVersion;
        var runner = function () {
            if (executedVersion < current) {
                executedVersion = scheduledVersion;
                run(true);
            }
        };

        MSApp.execAsyncAtPriority(runner, priorityWwa);
        scheduledWwaPriority = priorityWwa;
    }

    function requestDrain(priority, name) {
        /// <signature helpKeyword="WinJS.Utilities.Scheduler.requestDrain">
        /// <summary locid="WinJS.Utilities.Scheduler.requestDrain">
        /// Runs jobs in the scheduler without timeslicing until all jobs at the
        /// specified priority and higher have executed.
        /// </summary>
        /// <param name="priority" isOptional="true" type="WinJS.Utilities.Scheduler.Priority" locid="WinJS.Utilities.Scheduler.requestDrain_p:priority">
        /// The priority to which the scheduler should drain. The default is Priority.min, which drains all jobs in the queue.
        /// </param>
        /// <param name="name" isOptional="true" type="String" locid="WinJS.Utilities.Scheduler.requestDrain_p:name">
        /// An optional description of the drain request for diagnostics.
        /// </param>
        /// <returns type="WinJS.Promise" locid="WinJS.Utilities.Scheduler.requestDrain_returnValue">
        /// A promise which completes when the drain has finished. Canceling this
        /// promise cancels the drain request. This promise will never enter an error state.
        /// </returns>
        /// </signature>
        
        var id = globalDrainId++;
        if (name === undefined) {
            name = "Drain Request " + id;
        }
        priority = (+priority === priority) ? priority : Priority.min;
        priority = clampPriority(priority);

        var complete;
        var promise = new Promise(function (c) {
            complete = c;
            addDrainListener(priority, complete, name);
        }, function () {
            removeDrainListener(complete, true);
        });

        if (!pumping) {
            startRunning();
        }

        return promise;
    }

    function execHigh(callback) {
        /// <signature helpKeyword="WinJS.Utilities.Scheduler.execHigh">
        /// <summary locid="WinJS.Utilities.Scheduler.execHigh">
        /// Runs the specified callback in a high priority context.
        /// </summary>
        /// <param name="callback" type="Function" locid="WinJS.Utilities.Scheduler.execHigh_p:callback">
        /// The callback to run in a high priority context.
        /// </param>
        /// <returns type="Object" locid="WinJS.Utilities.Scheduler.execHigh_returnValue">
        /// The return value of the callback.
        /// </returns>
        /// </signature>

        return MSApp.execAtPriority(callback, MSApp.HIGH);
    }

    function createOwnerToken() {
        /// <signature helpKeyword="WinJS.Utilities.Scheduler.createOwnerToken">
        /// <summary locid="WinJS.Utilities.Scheduler.createOwnerToken">
        /// Creates and returns a new owner token which can be set to the owner property of one or more jobs.
        /// It can then be used to cancel all jobs it "owns". 
        /// </summary>
        /// <returns type="WinJS.Utilities.Scheduler._OwnerToken" locid="WinJS.Utilities.Scheduler.createOwnerToken_returnValue">
        /// The new owner token. You can use this token to control jobs that it owns. 
        /// </returns>
        /// </signature>

        return new OwnerToken();
    }

    function schedule(work, priority, thisArg, name) {
        /// <signature helpKeyword="WinJS.Utilities.Scheduler.schedule">
        /// <summary locid="WinJS.Utilities.Scheduler.schedule">
        /// Schedules the specified function to execute asynchronously.
        /// </summary>
        /// <param name="work" type="Function" locid="WinJS.Utilities.Scheduler.schedule_p:work">
        /// A function that represents the work item to be scheduled. When called the work item will receive as its first argument  
        /// a JobInfo object which allows the work item to ask the scheduler if it should yield cooperatively and if so allows the 
        /// work item to either provide a function to be run as a continuation or a WinJS.Promise which will when complete
        /// provide a function to run as a continuation.
        /// </param>
        /// <param name="priority" isOptional="true" type="WinJS.Utilities.Scheduler.Priority" locid="WinJS.Utilities.Scheduler.schedule_p:priority">
        /// The priority at which to schedule the work item. The default value is Priority.normal. 
        /// </param>
        /// <param name="thisArg" isOptional="true" type="Object" locid="WinJS.Utilities.Scheduler.schedule_p:thisArg">
        /// A 'this' instance to be bound into the work item. The default value is null. 
        /// </param>
        /// <param name="name" isOptional="true" type="String" locid="WinJS.Utilities.Scheduler.schedule_p:name">
        /// A description of the work item for diagnostics. The default value is an empty string. 
        /// </param>
        /// <returns type="WinJS.Utilities.Scheduler._JobNode" locid="WinJS.Utilities.Scheduler.schedule_returnValue">
        /// The Job instance which represents this work item.
        /// </returns>
        /// </signature>

        priority = priority || Priority.normal;
        thisArg = thisArg || null;
        var jobId = ++globalJobId;
        var asyncOpID = _Trace._traceAsyncOperationStarting("WinJS.Utilities.Scheduler.schedule: " + jobId + profilerMarkArgs(name));
        name = name || "";
        return new JobNode(jobId, work, priority, thisArg, name, asyncOpID);
    }

    function getCurrentPriority() {
        if (pumping) {
            return pumpingPriority;
        } else {
            switch (MSApp.getCurrentPriority()) {
                case MSApp.HIGH: return Priority.high;
                case MSApp.NORMAL: return Priority.normal;
                case MSApp.IDLE: return Priority.idle;
            }
        }
    }

    function makeSchedulePromise(priority) {
        return function (promiseValue, jobName) {
            /// <signature helpKeyword="WinJS.Utilities.Scheduler.schedulePromise">
            /// <summary locid="WinJS.Utilities.Scheduler.schedulePromise">
            /// Schedules a job to complete a returned Promise.
            /// There are four versions of this method for different commonly used priorities: schedulePromiseHigh,
            /// schedulePromiseAboveNormal, schedulePromiseNormal, schedulePromiseBelowNormal,
            /// and schedulePromiseIdle. 
            /// Example usage which shows how to
            /// ensure that the last link in a promise chain is run on the scheduler at high priority:
            /// asyncOp().then(Scheduler.schedulePromiseHigh).then(function (valueOfAsyncOp) { });
            /// </summary>
            /// <param name="promiseValue" isOptional="true" type="Object" locid="WinJS.Utilities.Scheduler.schedulePromise_p:promiseValue">
            /// The value with which the returned promise will complete.
            /// </param>
            /// <param name="jobName" isOptional="true" type="String" locid="WinJS.Utilities.Scheduler.schedulePromise_p:jobName">
            /// A string that describes the job for diagnostic purposes.
            /// </param>
            /// <returns type="WinJS.Promise" locid="WinJS.Utilities.Scheduler.schedulePromise_returnValue">
            /// A promise which completes within a job of the desired priority.
            /// </returns>
            /// </signature>
            var job;
            return new Promise(
                function (c) {
                    job = schedule(function schedulePromise() {
                        c(promiseValue);
                    }, priority, null, jobName);
                },
                function () {
                    job.cancel();
                }
            );
        };
    }

    _Base.Namespace._moduleDefine(exports, "WinJS.Utilities.Scheduler", {

        Priority: Priority,

        schedule: schedule,

        createOwnerToken: createOwnerToken,

        execHigh: execHigh,

        requestDrain: requestDrain,

        /// <field type="WinJS.Utilities.Scheduler.Priority" locid="WinJS.Utilities.Scheduler.currentPriority" helpKeyword="WinJS.Utilities.Scheduler.currentPriority">
        /// Gets the current priority at which the caller is executing.
        /// </field>
        currentPriority: {
            get: getCurrentPriority
        },

        // Promise helpers
        //
        schedulePromiseHigh: makeSchedulePromise(Priority.high),
        schedulePromiseAboveNormal: makeSchedulePromise(Priority.aboveNormal),
        schedulePromiseNormal: makeSchedulePromise(Priority.normal),
        schedulePromiseBelowNormal: makeSchedulePromise(Priority.belowNormal),
        schedulePromiseIdle: makeSchedulePromise(Priority.idle),

        retrieveState: retrieveState,

        _JobNode: JobNode,

        _JobInfo: JobInfo,

        _OwnerToken: OwnerToken,

        _dumpList: dumpList,

        _isEmpty: {
            get: isEmpty
        },

        // The properties below are used for testing.
        //

        _usingWwaScheduler: {
            get: function () {
                return usingWwaScheduler;
            },
            set: function (value) {
                usingWwaScheduler = value;
                MSApp = (usingWwaScheduler ? _Global.MSApp : MSAppStubs);
            }
        },

        _MSApp: {
            get: function () {
                return MSApp;
            },
            set: function (value) {
                MSApp = value;
            }
        },

        _TIME_SLICE: TIME_SLICE

    });

});


// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
(function(global) {
    "use strict";
    define('WinJS/Core/_Global',global);
})(this);
// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_BaseCoreUtils',[
    './_Global'
    ], function baseCoreUtilsInit(_Global) {
    "use strict";

    var hasWinRT = !!_Global.Windows;

    function markSupportedForProcessing(func) {
        /// <signature helpKeyword="WinJS.Utilities.markSupportedForProcessing">
        /// <summary locid="WinJS.Utilities.markSupportedForProcessing">
        /// Marks a function as being compatible with declarative processing, such as WinJS.UI.processAll
        /// or WinJS.Binding.processAll.
        /// </summary>
        /// <param name="func" type="Function" locid="WinJS.Utilities.markSupportedForProcessing_p:func">
        /// The function to be marked as compatible with declarative processing.
        /// </param>
        /// <returns type="Function" locid="WinJS.Utilities.markSupportedForProcessing_returnValue">
        /// The input function.
        /// </returns>
        /// </signature>
        func.supportedForProcessing = true;
        return func;
    }

    return {
        hasWinRT: hasWinRT,
        markSupportedForProcessing: markSupportedForProcessing,
        _setImmediate: _Global.setImmediate ? _Global.setImmediate.bind(_Global) : function (handler) {
            _Global.setTimeout(handler, 0);
        }
    };
});
// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
/* global WinJS */
define('WinJS/Core/_WriteProfilerMark',[
    ], function profilerInit() {
    "use strict";

    return WinJS.Utilities._writeProfilerMark;
});
// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
/* global WinJS */
define('WinJS/Core/_Base',[
    './_Global',
    './_BaseCoreUtils',
    './_WriteProfilerMark'
    ], function baseInit(_Global, _BaseCoreUtils, _WriteProfilerMark) {
    "use strict";

    function initializeProperties(target, members, prefix) {
        var keys = Object.keys(members);
        var isArray = Array.isArray(target);
        var properties;
        var i, len;
        for (i = 0, len = keys.length; i < len; i++) {
            var key = keys[i];
            var enumerable = key.charCodeAt(0) !== /*_*/95;
            var member = members[key];
            if (member && typeof member === 'object') {
                if (member.value !== undefined || typeof member.get === 'function' || typeof member.set === 'function') {
                    if (member.enumerable === undefined) {
                        member.enumerable = enumerable;
                    }
                    if (prefix && member.setName && typeof member.setName === 'function') {
                        member.setName(prefix + "." + key);
                    }
                    properties = properties || {};
                    properties[key] = member;
                    continue;
                }
            }
            if (!enumerable) {
                properties = properties || {};
                properties[key] = { value: member, enumerable: enumerable, configurable: true, writable: true };
                continue;
            }
            if(isArray) {
                target.forEach(function(target) {
                    target[key] = member;
                });
            } else {
                target[key] = member;
            }
        }
        if (properties) {
            if(isArray) {
                target.forEach(function(target) {
                    Object.defineProperties(target, properties);
                });
            } else {
                Object.defineProperties(target, properties);
            }
        }
    }

    (function (rootNamespace) {

        // Create the rootNamespace in the global namespace
        if (!_Global[rootNamespace]) {
            _Global[rootNamespace] = Object.create(Object.prototype);
        }

        // Cache the rootNamespace we just created in a local variable
        var _rootNamespace = _Global[rootNamespace];
        if (!_rootNamespace.Namespace) {
            _rootNamespace.Namespace = Object.create(Object.prototype);
        }

        function createNamespace(parentNamespace, name) {
            var currentNamespace = parentNamespace || {};
            if(name) {
                var namespaceFragments = name.split(".");
                for (var i = 0, len = namespaceFragments.length; i < len; i++) {
                    var namespaceName = namespaceFragments[i];
                    if (!currentNamespace[namespaceName]) {
                        Object.defineProperty(currentNamespace, namespaceName,
                            { value: {}, writable: false, enumerable: true, configurable: true }
                        );
                    }
                    currentNamespace = currentNamespace[namespaceName];
                }
            }
            return currentNamespace;
        }

        function defineWithParent(parentNamespace, name, members) {
            /// <signature helpKeyword="WinJS.Namespace.defineWithParent">
            /// <summary locid="WinJS.Namespace.defineWithParent">
            /// Defines a new namespace with the specified name under the specified parent namespace.
            /// </summary>
            /// <param name="parentNamespace" type="Object" locid="WinJS.Namespace.defineWithParent_p:parentNamespace">
            /// The parent namespace.
            /// </param>
            /// <param name="name" type="String" locid="WinJS.Namespace.defineWithParent_p:name">
            /// The name of the new namespace.
            /// </param>
            /// <param name="members" type="Object" locid="WinJS.Namespace.defineWithParent_p:members">
            /// The members of the new namespace.
            /// </param>
            /// <returns type="Object" locid="WinJS.Namespace.defineWithParent_returnValue">
            /// The newly-defined namespace.
            /// </returns>
            /// </signature>
            var currentNamespace = createNamespace(parentNamespace, name);

            if (members) {
                initializeProperties(currentNamespace, members, name || "<ANONYMOUS>");
            }

            return currentNamespace;
        }

        function define(name, members) {
            /// <signature helpKeyword="WinJS.Namespace.define">
            /// <summary locid="WinJS.Namespace.define">
            /// Defines a new namespace with the specified name.
            /// </summary>
            /// <param name="name" type="String" locid="WinJS.Namespace.define_p:name">
            /// The name of the namespace. This could be a dot-separated name for nested namespaces.
            /// </param>
            /// <param name="members" type="Object" locid="WinJS.Namespace.define_p:members">
            /// The members of the new namespace.
            /// </param>
            /// <returns type="Object" locid="WinJS.Namespace.define_returnValue">
            /// The newly-defined namespace.
            /// </returns>
            /// </signature>
            return defineWithParent(_Global, name, members);
        }

        var LazyStates = {
            uninitialized: 1,
            working: 2,
            initialized: 3,
        };

        function lazy(f) {
            var name;
            var state = LazyStates.uninitialized;
            var result;
            return {
                setName: function (value) {
                    name = value;
                },
                get: function () {
                    switch (state) {
                        case LazyStates.initialized:
                            return result;

                        case LazyStates.uninitialized:
                            state = LazyStates.working;
                            try {
                                _WriteProfilerMark("WinJS.Namespace._lazy:" + name + ",StartTM");
                                result = f();
                            } finally {
                                _WriteProfilerMark("WinJS.Namespace._lazy:" + name + ",StopTM");
                                state = LazyStates.uninitialized;
                            }
                            f = null;
                            state = LazyStates.initialized;
                            return result;

                        case LazyStates.working:
                            throw "Illegal: reentrancy on initialization";

                        default:
                            throw "Illegal";
                    }
                },
                set: function (value) {
                    switch (state) {
                        case LazyStates.working:
                            throw "Illegal: reentrancy on initialization";

                        default:
                            state = LazyStates.initialized;
                            result = value;
                            break;
                    }
                },
                enumerable: true,
                configurable: true,
            };
        }

        // helper for defining AMD module members
        function moduleDefine(exports, name, members) {
            var target = [exports];
            var publicNS = null;
            if(name) {
                publicNS = createNamespace(_Global, name);
                target.push(publicNS);
            }
            initializeProperties(target, members, name || "<ANONYMOUS>");
            return publicNS;
        }

        // Establish members of the "WinJS.Namespace" namespace
        Object.defineProperties(_rootNamespace.Namespace, {

            defineWithParent: { value: defineWithParent, writable: true, enumerable: true, configurable: true },

            define: { value: define, writable: true, enumerable: true, configurable: true },

            _lazy: { value: lazy, writable: true, enumerable: true, configurable: true },

            _moduleDefine: { value: moduleDefine, writable: true, enumerable: true, configurable: true }

        });

    })("WinJS");

    (function (WinJS) {

        function define(constructor, instanceMembers, staticMembers) {
            /// <signature helpKeyword="WinJS.Class.define">
            /// <summary locid="WinJS.Class.define">
            /// Defines a class using the given constructor and the specified instance members.
            /// </summary>
            /// <param name="constructor" type="Function" locid="WinJS.Class.define_p:constructor">
            /// A constructor function that is used to instantiate this class.
            /// </param>
            /// <param name="instanceMembers" type="Object" locid="WinJS.Class.define_p:instanceMembers">
            /// The set of instance fields, properties, and methods made available on the class.
            /// </param>
            /// <param name="staticMembers" type="Object" locid="WinJS.Class.define_p:staticMembers">
            /// The set of static fields, properties, and methods made available on the class.
            /// </param>
            /// <returns type="Function" locid="WinJS.Class.define_returnValue">
            /// The newly-defined class.
            /// </returns>
            /// </signature>
            constructor = constructor || function () { };
            _BaseCoreUtils.markSupportedForProcessing(constructor);
            if (instanceMembers) {
                initializeProperties(constructor.prototype, instanceMembers);
            }
            if (staticMembers) {
                initializeProperties(constructor, staticMembers);
            }
            return constructor;
        }

        function derive(baseClass, constructor, instanceMembers, staticMembers) {
            /// <signature helpKeyword="WinJS.Class.derive">
            /// <summary locid="WinJS.Class.derive">
            /// Creates a sub-class based on the supplied baseClass parameter, using prototypal inheritance.
            /// </summary>
            /// <param name="baseClass" type="Function" locid="WinJS.Class.derive_p:baseClass">
            /// The class to inherit from.
            /// </param>
            /// <param name="constructor" type="Function" locid="WinJS.Class.derive_p:constructor">
            /// A constructor function that is used to instantiate this class.
            /// </param>
            /// <param name="instanceMembers" type="Object" locid="WinJS.Class.derive_p:instanceMembers">
            /// The set of instance fields, properties, and methods to be made available on the class.
            /// </param>
            /// <param name="staticMembers" type="Object" locid="WinJS.Class.derive_p:staticMembers">
            /// The set of static fields, properties, and methods to be made available on the class.
            /// </param>
            /// <returns type="Function" locid="WinJS.Class.derive_returnValue">
            /// The newly-defined class.
            /// </returns>
            /// </signature>
            if (baseClass) {
                constructor = constructor || function () { };
                var basePrototype = baseClass.prototype;
                constructor.prototype = Object.create(basePrototype);
                _BaseCoreUtils.markSupportedForProcessing(constructor);
                Object.defineProperty(constructor.prototype, "constructor", { value: constructor, writable: true, configurable: true, enumerable: true });
                if (instanceMembers) {
                    initializeProperties(constructor.prototype, instanceMembers);
                }
                if (staticMembers) {
                    initializeProperties(constructor, staticMembers);
                }
                return constructor;
            } else {
                return define(constructor, instanceMembers, staticMembers);
            }
        }

        function mix(constructor) {
            /// <signature helpKeyword="WinJS.Class.mix">
            /// <summary locid="WinJS.Class.mix">
            /// Defines a class using the given constructor and the union of the set of instance members
            /// specified by all the mixin objects. The mixin parameter list is of variable length.
            /// </summary>
            /// <param name="constructor" locid="WinJS.Class.mix_p:constructor">
            /// A constructor function that is used to instantiate this class.
            /// </param>
            /// <returns type="Function" locid="WinJS.Class.mix_returnValue">
            /// The newly-defined class.
            /// </returns>
            /// </signature>
            constructor = constructor || function () { };
            var i, len;
            for (i = 1, len = arguments.length; i < len; i++) {
                initializeProperties(constructor.prototype, arguments[i]);
            }
            return constructor;
        }

        // Establish members of "WinJS.Class" namespace
        WinJS.Namespace.define("WinJS.Class", {
            define: define,
            derive: derive,
            mix: mix
        });

    })(WinJS);

    return {
        Namespace: WinJS.Namespace,
        Class: WinJS.Class
    };

});
// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_ErrorFromName',[
    './_Base'
    ], function errorsInit(_Base) {
    "use strict";

    var ErrorFromName = _Base.Class.derive(Error, function (name, message) {
        /// <signature helpKeyword="WinJS.ErrorFromName">
        /// <summary locid="WinJS.ErrorFromName">
        /// Creates an Error object with the specified name and message properties.
        /// </summary>
        /// <param name="name" type="String" locid="WinJS.ErrorFromName_p:name">The name of this error. The name is meant to be consumed programmatically and should not be localized.</param>
        /// <param name="message" type="String" optional="true" locid="WinJS.ErrorFromName_p:message">The message for this error. The message is meant to be consumed by humans and should be localized.</param>
        /// <returns type="Error" locid="WinJS.ErrorFromName_returnValue">Error instance with .name and .message properties populated</returns>
        /// </signature>
        this.name = name;
        this.message = message || name;
    }, {
        /* empty */
    }, {
        supportedForProcessing: false,
    });

    _Base.Namespace.define("WinJS", {
        // ErrorFromName establishes a simple pattern for returning error codes.
        //
        ErrorFromName: ErrorFromName
    });

    return ErrorFromName;

});


// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_WinRT',[
    'exports',
    './_Global',
    './_Base',
], function winrtInit(exports, _Global, _Base) {
    "use strict";

    exports.msGetWeakWinRTProperty = _Global.msGetWeakWinRTProperty;
    exports.msSetWeakWinRTProperty = _Global.msSetWeakWinRTProperty;

    var APIs = [
        "Windows.ApplicationModel.DesignMode.designModeEnabled",
        "Windows.ApplicationModel.Resources.Core.ResourceManager",
        "Windows.ApplicationModel.Search.Core.SearchSuggestionManager",
        "Windows.ApplicationModel.Search.SearchQueryLinguisticDetails",
        "Windows.Data.Text.SemanticTextQuery",
        "Windows.Foundation.Collections.CollectionChange",
        "Windows.Foundation.Uri",
        "Windows.Globalization.ApplicationLanguages",
        "Windows.Globalization.Calendar",
        "Windows.Globalization.DateTimeFormatting",
        "Windows.Globalization.Language",
        "Windows.Phone.UI.Input.HardwareButtons",
        "Windows.Storage.ApplicationData",
        "Windows.Storage.CreationCollisionOption",
        "Windows.Storage.BulkAccess.FileInformationFactory",
        "Windows.Storage.FileIO",
        "Windows.Storage.FileProperties.ThumbnailType",
        "Windows.Storage.FileProperties.ThumbnailMode",
        "Windows.Storage.FileProperties.ThumbnailOptions",
        "Windows.Storage.KnownFolders",
        "Windows.Storage.Search.FolderDepth",
        "Windows.Storage.Search.IndexerOption",
        "Windows.UI.ApplicationSettings.SettingsEdgeLocation",
        "Windows.UI.ApplicationSettings.SettingsCommand",
        "Windows.UI.ApplicationSettings.SettingsPane",
        "Windows.UI.Core.AnimationMetrics",
        "Windows.UI.Input.EdgeGesture",
        "Windows.UI.Input.EdgeGestureKind",
        "Windows.UI.Input.PointerPoint",
        "Windows.UI.ViewManagement.HandPreference",
        "Windows.UI.ViewManagement.InputPane",
        "Windows.UI.ViewManagement.UISettings",
        "Windows.UI.WebUI.Core.WebUICommandBar",
        "Windows.UI.WebUI.Core.WebUICommandBarBitmapIcon",
        "Windows.UI.WebUI.Core.WebUICommandBarClosedDisplayMode",
        "Windows.UI.WebUI.Core.WebUICommandBarIconButton",
        "Windows.UI.WebUI.Core.WebUICommandBarSymbolIcon",
        "Windows.UI.WebUI.WebUIApplication",
    ];

    APIs.forEach(function (api) {
        var parts = api.split(".");
        var leaf = {};
        leaf[parts[parts.length - 1]] = {
            get: function () {
                return parts.reduce(function (current, part) { return current ? current[part] : null; }, _Global);
            }
        };
        _Base.Namespace.defineWithParent(exports, parts.slice(0, -1).join("."), leaf);
    });

});

// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_Events',[
    'exports',
    './_Base'
    ], function eventsInit(exports, _Base) {
    "use strict";


    function createEventProperty(name) {
        var eventPropStateName = "_on" + name + "state";

        return {
            get: function () {
                var state = this[eventPropStateName];
                return state && state.userHandler;
            },
            set: function (handler) {
                var state = this[eventPropStateName];
                if (handler) {
                    if (!state) {
                        state = { wrapper: function (evt) { return state.userHandler(evt); }, userHandler: handler };
                        Object.defineProperty(this, eventPropStateName, { value: state, enumerable: false, writable:true, configurable: true });
                        this.addEventListener(name, state.wrapper, false);
                    }
                    state.userHandler = handler;
                } else if (state) {
                    this.removeEventListener(name, state.wrapper, false);
                    this[eventPropStateName] = null;
                }
            },
            enumerable: true
        };
    }

    function createEventProperties() {
        /// <signature helpKeyword="WinJS.Utilities.createEventProperties">
        /// <summary locid="WinJS.Utilities.createEventProperties">
        /// Creates an object that has one property for each name passed to the function.
        /// </summary>
        /// <param name="events" locid="WinJS.Utilities.createEventProperties_p:events">
        /// A variable list of property names.
        /// </param>
        /// <returns type="Object" locid="WinJS.Utilities.createEventProperties_returnValue">
        /// The object with the specified properties. The names of the properties are prefixed with 'on'.
        /// </returns>
        /// </signature>
        var props = {};
        for (var i = 0, len = arguments.length; i < len; i++) {
            var name = arguments[i];
            props["on" + name] = createEventProperty(name);
        }
        return props;
    }

    var EventMixinEvent = _Base.Class.define(
        function EventMixinEvent_ctor(type, detail, target) {
            this.detail = detail;
            this.target = target;
            this.timeStamp = Date.now();
            this.type = type;
        },
        {
            bubbles: { value: false, writable: false },
            cancelable: { value: false, writable: false },
            currentTarget: {
                get: function () { return this.target; }
            },
            defaultPrevented: {
                get: function () { return this._preventDefaultCalled; }
            },
            trusted: { value: false, writable: false },
            eventPhase: { value: 0, writable: false },
            target: null,
            timeStamp: null,
            type: null,

            preventDefault: function () {
                this._preventDefaultCalled = true;
            },
            stopImmediatePropagation: function () {
                this._stopImmediatePropagationCalled = true;
            },
            stopPropagation: function () {
            }
        }, {
            supportedForProcessing: false,
        }
    );

    var eventMixin = {
        _listeners: null,

        addEventListener: function (type, listener, useCapture) {
            /// <signature helpKeyword="WinJS.Utilities.eventMixin.addEventListener">
            /// <summary locid="WinJS.Utilities.eventMixin.addEventListener">
            /// Adds an event listener to the control.
            /// </summary>
            /// <param name="type" locid="WinJS.Utilities.eventMixin.addEventListener_p:type">
            /// The type (name) of the event.
            /// </param>
            /// <param name="listener" locid="WinJS.Utilities.eventMixin.addEventListener_p:listener">
            /// The listener to invoke when the event is raised.
            /// </param>
            /// <param name="useCapture" locid="WinJS.Utilities.eventMixin.addEventListener_p:useCapture">
            /// if true initiates capture, otherwise false.
            /// </param>
            /// </signature>
            useCapture = useCapture || false;
            this._listeners = this._listeners || {};
            var eventListeners = (this._listeners[type] = this._listeners[type] || []);
            for (var i = 0, len = eventListeners.length; i < len; i++) {
                var l = eventListeners[i];
                if (l.useCapture === useCapture && l.listener === listener) {
                    return;
                }
            }
            eventListeners.push({ listener: listener, useCapture: useCapture });
        },
        dispatchEvent: function (type, details) {
            /// <signature helpKeyword="WinJS.Utilities.eventMixin.dispatchEvent">
            /// <summary locid="WinJS.Utilities.eventMixin.dispatchEvent">
            /// Raises an event of the specified type and with the specified additional properties.
            /// </summary>
            /// <param name="type" locid="WinJS.Utilities.eventMixin.dispatchEvent_p:type">
            /// The type (name) of the event.
            /// </param>
            /// <param name="details" locid="WinJS.Utilities.eventMixin.dispatchEvent_p:details">
            /// The set of additional properties to be attached to the event object when the event is raised.
            /// </param>
            /// <returns type="Boolean" locid="WinJS.Utilities.eventMixin.dispatchEvent_returnValue">
            /// true if preventDefault was called on the event.
            /// </returns>
            /// </signature>
            var listeners = this._listeners && this._listeners[type];
            if (listeners) {
                var eventValue = new EventMixinEvent(type, details, this);
                // Need to copy the array to protect against people unregistering while we are dispatching
                listeners = listeners.slice(0, listeners.length);
                for (var i = 0, len = listeners.length; i < len && !eventValue._stopImmediatePropagationCalled; i++) {
                    listeners[i].listener(eventValue);
                }
                return eventValue.defaultPrevented || false;
            }
            return false;
        },
        removeEventListener: function (type, listener, useCapture) {
            /// <signature helpKeyword="WinJS.Utilities.eventMixin.removeEventListener">
            /// <summary locid="WinJS.Utilities.eventMixin.removeEventListener">
            /// Removes an event listener from the control.
            /// </summary>
            /// <param name="type" locid="WinJS.Utilities.eventMixin.removeEventListener_p:type">
            /// The type (name) of the event.
            /// </param>
            /// <param name="listener" locid="WinJS.Utilities.eventMixin.removeEventListener_p:listener">
            /// The listener to remove.
            /// </param>
            /// <param name="useCapture" locid="WinJS.Utilities.eventMixin.removeEventListener_p:useCapture">
            /// Specifies whether to initiate capture.
            /// </param>
            /// </signature>
            useCapture = useCapture || false;
            var listeners = this._listeners && this._listeners[type];
            if (listeners) {
                for (var i = 0, len = listeners.length; i < len; i++) {
                    var l = listeners[i];
                    if (l.listener === listener && l.useCapture === useCapture) {
                        listeners.splice(i, 1);
                        if (listeners.length === 0) {
                            delete this._listeners[type];
                        }
                        // Only want to remove one element for each call to removeEventListener
                        break;
                    }
                }
            }
        }
    };

    _Base.Namespace._moduleDefine(exports, "WinJS.Utilities", {
        _createEventProperty: createEventProperty,
        createEventProperties: createEventProperties,
        eventMixin: eventMixin
    });

});


// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_Resources',[
    'exports',
    './_Global',
    './_WinRT',
    './_Base',
    './_Events'
    ], function resourcesInit(exports, _Global, _WinRT, _Base, _Events) {
    "use strict";

    var appxVersion = "$(TARGET_DESTINATION)";
    var developerPrefix = "Developer.";
    if (appxVersion.indexOf(developerPrefix) === 0) {
        appxVersion = appxVersion.substring(developerPrefix.length);
    }

    function _getWinJSString(id) {
        return getString("ms-resource://" + appxVersion + "/" + id);
    }

    var resourceMap;
    var mrtEventHook = false;
    var contextChangedET = "contextchanged";
    var resourceContext;

    var ListenerType = _Base.Class.mix(_Base.Class.define(null, { /* empty */ }, { supportedForProcessing: false }), _Events.eventMixin);
    var listeners = new ListenerType();
    var createEvent = _Events._createEventProperty;

    var strings = {
        get malformedFormatStringInput() { return _getWinJSString("base/malformedFormatStringInput").value; },
    };

    _Base.Namespace.define("WinJS.Resources", {
        _getWinJSString: _getWinJSString
    });

    function formatString(string) {
        var args = arguments;
        if (args.length > 1) {
            string = string.replace(/({{)|(}})|{(\d+)}|({)|(})/g, function (unused, left, right, index, illegalLeft, illegalRight) {
                if (illegalLeft || illegalRight) { throw formatString(strings.malformedFormatStringInput, illegalLeft || illegalRight); }
                return (left && "{") || (right && "}") || args[(index | 0) + 1];
            });
        }
        return string;
    }

    _Base.Namespace._moduleDefine(exports, "WinJS.Resources", {
        addEventListener: function (type, listener, useCapture) {
            /// <signature helpKeyword="WinJS.Resources.addEventListener">
            /// <summary locid="WinJS.Resources.addEventListener">
            /// Registers an event handler for the specified event.
            /// </summary>
            /// <param name='type' type="String" locid='WinJS.Resources.addEventListener_p:type'>
            /// The name of the event to handle.
            /// </param>
            /// <param name='listener' type="Function" locid='WinJS.Resources.addEventListener_p:listener'>
            /// The listener to invoke when the event gets raised.
            /// </param>
            /// <param name='useCapture' type="Boolean" locid='WinJS.Resources.addEventListener_p:useCapture'>
            /// Set to true to register the event handler for the capturing phase; set to false to register for the bubbling phase.
            /// </param>
            /// </signature>
            if (_WinRT.Windows.ApplicationModel.Resources.Core.ResourceManager && !mrtEventHook) {
                if (type === contextChangedET) {
                    try {
                        var resContext = exports._getResourceContext();
                        if (resContext) {
                            resContext.qualifierValues.addEventListener("mapchanged", function (e) {
                                exports.dispatchEvent(contextChangedET, { qualifier: e.key, changed: e.target[e.key] });
                            }, false);

                        } else {
                            // The API can be called in the Background thread (web worker).
                            _WinRT.Windows.ApplicationModel.Resources.Core.ResourceManager.current.defaultContext.qualifierValues.addEventListener("mapchanged", function (e) {
                                exports.dispatchEvent(contextChangedET, { qualifier: e.key, changed: e.target[e.key] });
                            }, false);
                        }
                        mrtEventHook = true;
                    } catch (e) {
                    }
                }
            }
            listeners.addEventListener(type, listener, useCapture);
        },
        removeEventListener: listeners.removeEventListener.bind(listeners),
        dispatchEvent: listeners.dispatchEvent.bind(listeners),

        _formatString: formatString,

        _getStringWinRT: function (resourceId) {
            if (!resourceMap) {
                var mainResourceMap = _WinRT.Windows.ApplicationModel.Resources.Core.ResourceManager.current.mainResourceMap;
                try {
                    resourceMap = mainResourceMap.getSubtree('Resources');
                }
                catch (e) {
                }
                if (!resourceMap) {
                    resourceMap = mainResourceMap;
                }
            }

            var stringValue;
            var langValue;
            var resCandidate;
            try {
                var resContext = exports._getResourceContext();
                if (resContext) {
                    resCandidate = resourceMap.getValue(resourceId, resContext);
                } else {
                    resCandidate = resourceMap.getValue(resourceId);
                }

                if (resCandidate) {
                    stringValue = resCandidate.valueAsString;
                    if (stringValue === undefined) {
                        stringValue = resCandidate.toString();
                    }
                }
            }
            catch (e) { }

            if (!stringValue) {
                return { value: resourceId, empty: true };
            }

            try {
                langValue = resCandidate.getQualifierValue("Language");
            }
            catch (e) {
                return { value: stringValue };
            }

            return { value: stringValue, lang: langValue };
        },

        _getStringJS: function (resourceId) {
            var str = _Global.strings && _Global.strings[resourceId];
            if (typeof str === "string") {
                str = { value: str };
            }
            return str || { value: resourceId, empty: true };
        },

        _getResourceContext: function () {
            if (_Global.document) {
                if (!resourceContext) {
                    resourceContext = _WinRT.Windows.ApplicationModel.Resources.Core.ResourceContext.getForCurrentView();
                }
            }
            return resourceContext;
        },

        oncontextchanged: createEvent(contextChangedET)
        
    });

    var getStringImpl = _WinRT.Windows.ApplicationModel.Resources.Core.ResourceManager ? exports._getStringWinRT : exports._getStringJS;

    var getString = function (resourceId) {
        /// <signature helpKeyword="WinJS.Resources.getString">
        /// <summary locid='WinJS.Resources.getString'>
        /// Retrieves the resource string that has the specified resource id.
        /// </summary>
        /// <param name='resourceId' type="Number" locid='WinJS.Resources.getString._p:resourceId'>
        /// The resource id of the string to retrieve.
        /// </param>
        /// <returns type='Object' locid='WinJS.Resources.getString_returnValue'>
        /// An object that can contain these properties:
        /// 
        /// value:
        /// The value of the requested string. This property is always present.
        /// 
        /// empty:
        /// A value that specifies whether the requested string wasn't found.
        /// If its true, the string wasn't found. If its false or undefined,
        /// the requested string was found.
        /// 
        /// lang:
        /// The language of the string, if specified. This property is only present
        /// for multi-language resources.
        /// 
        /// </returns>
        /// </signature>          

        return getStringImpl(resourceId);
    };

    _Base.Namespace._moduleDefine(exports, null, {
        _formatString: formatString,
        _getWinJSString: _getWinJSString
    });

    _Base.Namespace._moduleDefine(exports, "WinJS.Resources", {
        getString: {
            get: function() {
                return getString;
            },
            set: function(value) {
                getString = value;
            }
        }
    });

});

// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_Trace',[
    './_Global'
    ], function traceInit(_Global) {
    "use strict";

    function nop(v) {
        return v;
    }

    return {
        _traceAsyncOperationStarting: (_Global.Debug && _Global.Debug.msTraceAsyncOperationStarting && _Global.Debug.msTraceAsyncOperationStarting.bind(_Global.Debug)) || nop,
        _traceAsyncOperationCompleted: (_Global.Debug && _Global.Debug.msTraceAsyncOperationCompleted && _Global.Debug.msTraceAsyncOperationCompleted.bind(_Global.Debug)) || nop,
        _traceAsyncCallbackStarting: (_Global.Debug && _Global.Debug.msTraceAsyncCallbackStarting && _Global.Debug.msTraceAsyncCallbackStarting.bind(_Global.Debug)) || nop,
        _traceAsyncCallbackCompleted: (_Global.Debug && _Global.Debug.msTraceAsyncCallbackCompleted && _Global.Debug.msTraceAsyncCallbackCompleted.bind(_Global.Debug)) || nop
    };
});
// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_Log',[
    'exports',
    './_Global',
    './_Base',
    ], function logInit(exports, _Global, _Base) {
    "use strict";

    var spaceR = /\s+/g;
    var typeR = /^(error|warn|info|log)$/;
    var WinJSLog = null;

    function format(message, tag, type) {
        /// <signature helpKeyword="WinJS.Utilities.formatLog">
        /// <summary locid="WinJS.Utilities.formatLog">
        /// Adds tags and type to a logging message.
        /// </summary>
        /// <param name="message" type="String" locid="WinJS.Utilities.startLog_p:message">The message to format.</param>
        /// <param name="tag" type="String" locid="WinJS.Utilities.startLog_p:tag">
        /// The tag(s) to apply to the message. Separate multiple tags with spaces.
        /// </param>
        /// <param name="type" type="String" locid="WinJS.Utilities.startLog_p:type">The type of the message.</param>
        /// <returns type="String" locid="WinJS.Utilities.startLog_returnValue">The formatted message.</returns>
        /// </signature>
        var m = message;
        if (typeof (m) === "function") { m = m(); }

        return ((type && typeR.test(type)) ? ("") : (type ? (type + ": ") : "")) +
            (tag ? tag.replace(spaceR, ":") + ": " : "") +
            m;
    }
    function defAction(message, tag, type) {
        var m = exports.formatLog(message, tag, type);
        if(_Global.console) {
            _Global.console[(type && typeR.test(type)) ? type : "log"](m);
        }
    }
    function escape(s) {
        // \s (whitespace) is used as separator, so don't escape it
        return s.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
    }
    _Base.Namespace._moduleDefine(exports, "WinJS.Utilities", {
        startLog: function (options) {
            /// <signature helpKeyword="WinJS.Utilities.startLog">
            /// <summary locid="WinJS.Utilities.startLog">
            /// Configures a logger that writes messages containing the specified tags from WinJS.log to console.log.
            /// </summary>
            /// <param name="options" type="String" locid="WinJS.Utilities.startLog_p:options">
            /// The tags for messages to log. Separate multiple tags with spaces.
            /// </param>
            /// </signature>
            /// <signature>
            /// <summary locid="WinJS.Utilities.startLog2">
            /// Configure a logger to write WinJS.log output.
            /// </summary>
            /// <param name="options" type="Object" locid="WinJS.Utilities.startLog_p:options2">
            /// May contain .type, .tags, .excludeTags and .action properties.
            ///  - .type is a required tag.
            ///  - .excludeTags is a space-separated list of tags, any of which will result in a message not being logged.
            ///  - .tags is a space-separated list of tags, any of which will result in a message being logged.
            ///  - .action is a function that, if present, will be called with the log message, tags and type. The default is to log to the console.
            /// </param>
            /// </signature>
            options = options || {};
            if (typeof options === "string") {
                options = { tags: options };
            }
            var el = options.type && new RegExp("^(" + escape(options.type).replace(spaceR, " ").split(" ").join("|") + ")$");
            var not = options.excludeTags && new RegExp("(^|\\s)(" + escape(options.excludeTags).replace(spaceR, " ").split(" ").join("|") + ")(\\s|$)", "i");
            var has = options.tags && new RegExp("(^|\\s)(" + escape(options.tags).replace(spaceR, " ").split(" ").join("|") + ")(\\s|$)", "i");
            var action = options.action || defAction;

            if (!el && !not && !has && !exports.log) {
                exports.log = action;
                return;
            }

            var result = function (message, tag, type) {
                if (!((el && !el.test(type))          // if the expected log level is not satisfied
                    || (not && not.test(tag))         // if any of the excluded categories exist
                    || (has && !has.test(tag)))) {    // if at least one of the included categories doesn't exist
                        action(message, tag, type);
                    }

                result.next && result.next(message, tag, type);
            };
            result.next = exports.log;
            exports.log = result;
        },
        stopLog: function () {
            /// <signature helpKeyword="WinJS.Utilities.stopLog">
            /// <summary locid="WinJS.Utilities.stopLog">
            /// Removes the previously set up logger.
            /// </summary>
            /// </signature>
            exports.log = null;
        },
        formatLog: format
    });

    _Base.Namespace._moduleDefine(exports, "WinJS", {
        log: {
            get: function() {
                return WinJSLog;
            },
            set: function(value) {
                WinJSLog = value;
            }
        }
    });
});

// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
define('WinJS/Core/_BaseUtils',[
    'exports',
    './_Global',
    './_Base',
    './_BaseCoreUtils',
    './_ErrorFromName',
    './_Resources',
    './_Trace',
    '../Promise',
    '../Scheduler'
    ], function baseUtilsInit(exports, _Global, _Base, _BaseCoreUtils, _ErrorFromName, _Resources, _Trace, Promise, Scheduler) {
    "use strict";

    var strings = {
        get notSupportedForProcessing() { return _Resources._getWinJSString("base/notSupportedForProcessing").value; }
    };

    var isPhone = false;
    var validation = false;

    function nop(v) {
        return v;
    }

    function getMemberFiltered(name, root, filter) {
        return name.split(".").reduce(function (currentNamespace, name) {
            if (currentNamespace) {
                return filter(currentNamespace[name]);
            }
            return null;
        }, root);
    }

    function getMember(name, root) {
        /// <signature helpKeyword="WinJS.Utilities.getMember">
        /// <summary locid="WinJS.Utilities.getMember">
        /// Gets the leaf-level type or namespace specified by the name parameter.
        /// </summary>
        /// <param name="name" locid="WinJS.Utilities.getMember_p:name">
        /// The name of the member.
        /// </param>
        /// <param name="root" locid="WinJS.Utilities.getMember_p:root">
        /// The root to start in. Defaults to the global object.
        /// </param>
        /// <returns type="Object" locid="WinJS.Utilities.getMember_returnValue">
        /// The leaf-level type or namespace in the specified parent namespace.
        /// </returns>
        /// </signature>
        if (!name) {
            return null;
        }
        return getMemberFiltered(name, root || _Global, nop);
    }

    function getCamelCasedName(styleName) {
        // special case -moz prefixed styles because their JS property name starts with Moz
        if (styleName.length > 0 && styleName.indexOf("-moz") !== 0 && styleName.charAt(0) === "-") {
            styleName = styleName.slice(1);
        }
        return styleName.replace(/\-[a-z]/g, function (x) { return x[1].toUpperCase(); });
    }

    function addPrefixToCamelCasedName(prefix, name) {
        if (prefix === "") {
            return name;
        }

        return prefix + name.charAt(0).toUpperCase() + name.slice(1);
    }

    function addPrefixToCSSName(prefix, name) {
        return (prefix !== "" ? "-" + prefix.toLowerCase() + "-" : "") + name;
    }

    function getBrowserStyleEquivalents() {
        // not supported in WebWorker
        if (!_Global.document) {
            return {};
        }

        var equivalents = {},
            docStyle = _Global.document.documentElement.style,
            stylePrefixesToTest = ["", "webkit", "ms", "Moz"],
            styles = ["animation",
                "transition",
                "transform",
                "animation-name",
                "animation-duration",
                "animation-delay",
                "animation-timing-function",
                "animation-iteration-count",
                "animation-direction",
                "animation-fill-mode",
                "grid-column",
                "grid-columns",
                "grid-column-span",
                "grid-row",
                "grid-rows",
                "grid-row-span",
                "transform-origin",
                "transition-property",
                "transition-duration",
                "transition-delay",
                "transition-timing-function",
                "scroll-snap-points-x",
                "scroll-snap-points-y",
                "scroll-chaining",
                "scroll-limit",
                "scroll-limit-x-max",
                "scroll-limit-x-min",
                "scroll-limit-y-max",
                "scroll-limit-y-min",
                "scroll-snap-type",
                "scroll-snap-x",
                "scroll-snap-y",
                "overflow-style",
                "user-select" // used for Template Compiler test
            ],
            prefixesUsedOnStyles = {};

        for (var i = 0, len = styles.length; i < len; i++) {
            var originalName = styles[i],
                styleToTest = getCamelCasedName(originalName);
            for (var j = 0, prefixLen = stylePrefixesToTest.length; j < prefixLen; j++) {
                var prefix = stylePrefixesToTest[j];
                var styleName = addPrefixToCamelCasedName(prefix, styleToTest);
                if (styleName in docStyle) {
                    // Firefox doesn't support dashed style names being get/set via script. (eg, something like element.style["transform-origin"] = "" wouldn't work).
                    // For each style translation we create, we'll make a CSS name version and a script name version for it so each can be used where appropriate.
                    var cssName = addPrefixToCSSName(prefix, originalName);
                    equivalents[originalName] = {
                        cssName: cssName,
                        scriptName: styleName
                    };
                    prefixesUsedOnStyles[originalName] = prefix;
                    break;
                }
            }
        }

        // Special cases:
        equivalents.animationPrefix = addPrefixToCSSName(prefixesUsedOnStyles["animation"], "");
        equivalents.keyframes = addPrefixToCSSName(prefixesUsedOnStyles["animation"], "keyframes");

        return equivalents;
    }

    function getBrowserEventEquivalents() {
        var equivalents = {};
        var animationEventPrefixes = ["", "WebKit"],
            animationEvents = [
                {
                    eventObject: "TransitionEvent",
                    events: ["transitionStart", "transitionEnd"]
                },
                {
                    eventObject: "AnimationEvent",
                    events: ["animationStart", "animationEnd"]
                }
            ];

        for (var i = 0, len = animationEvents.length; i < len; i++) {
            var eventToTest = animationEvents[i],
                chosenPrefix = "";
            for (var j = 0, prefixLen = animationEventPrefixes.length; j < prefixLen; j++) {
                var prefix = animationEventPrefixes[j];
                if ((prefix + eventToTest.eventObject) in _Global) {
                    chosenPrefix = prefix.toLowerCase();
                    break;
                }
            }
            for (var j = 0, eventsLen = eventToTest.events.length; j < eventsLen; j++) {
                var eventName = eventToTest.events[j];
                equivalents[eventName] = addPrefixToCamelCasedName(chosenPrefix, eventName);
                if (chosenPrefix === "") {
                    // Transition and animation events are case sensitive. When there's no prefix, the event name should be in lowercase.
                    // In IE, Chrome and Firefox, an event handler listening to transitionend will be triggered properly, but transitionEnd will not.
                    // When a prefix is provided, though, the event name needs to be case sensitive.
                    // IE and Firefox will trigger an animationend event handler correctly, but Chrome won't trigger webkitanimationend -- it has to be webkitAnimationEnd.
                    equivalents[eventName] = equivalents[eventName].toLowerCase();
                }
            }
        }

        // Non-standardized events
        equivalents["manipulationStateChanged"] = ("MSManipulationEvent" in _Global ? "ManipulationEvent" : null);
        return equivalents;
    }

    _Base.Namespace._moduleDefine(exports, "WinJS.Utilities", {
        // Used for mocking in tests
        _setHasWinRT: {
            value: function (value) {
                _BaseCoreUtils.hasWinRT = value;
            },
            configurable: false,
            writable: false,
            enumerable: false
        },

        /// <field type="Boolean" locid="WinJS.Utilities.hasWinRT" helpKeyword="WinJS.Utilities.hasWinRT">Determine if WinRT is accessible in this script context.</field>
        hasWinRT: {
            get: function () { return _BaseCoreUtils.hasWinRT; },
            configurable: false,
            enumerable: true
        },

        _getMemberFiltered: getMemberFiltered,

        getMember: getMember,

        _browserStyleEquivalents: getBrowserStyleEquivalents(),
        _browserEventEquivalents: getBrowserEventEquivalents(),
        _getCamelCasedName: getCamelCasedName,

        ready: function ready(callback, async) {
            /// <signature helpKeyword="WinJS.Utilities.ready">
            /// <summary locid="WinJS.Utilities.ready">
            /// Ensures that the specified function executes only after the DOMContentLoaded event has fired
            /// for the current page.
            /// </summary>
            /// <returns type="WinJS.Promise" locid="WinJS.Utilities.ready_returnValue">A promise that completes after DOMContentLoaded has occurred.</returns>
            /// <param name="callback" optional="true" locid="WinJS.Utilities.ready_p:callback">
            /// A function that executes after DOMContentLoaded has occurred.
            /// </param>
            /// <param name="async" optional="true" locid="WinJS.Utilities.ready_p:async">
            /// If true, the callback is executed asynchronously.
            /// </param>
            /// </signature>
            return new Promise(function (c, e) {
                function complete() {
                    if (callback) {
                        try {
                            callback();
                            c();
                        }
                        catch (err) {
                            e(err);
                        }
                    }
                    else {
                        c();
                    }
                }

                var readyState = ready._testReadyState;
                if (!readyState) {
                    if (_Global.document) {
                        readyState = _Global.document.readyState;
                    }
                    else {
                        readyState = "complete";
                    }
                }
                if (readyState === "complete" || (_Global.document && _Global.document.body !== null)) {
                    if (async) {
                        Scheduler.schedule(function WinJS_Utilities_ready() {
                            complete();
                        }, Scheduler.Priority.normal, null, "WinJS.Utilities.ready");
                    }
                    else {
                        complete();
                    }
                }
                else {
                    _Global.addEventListener("DOMContentLoaded", complete, false);
                }
            });
        },

        /// <field type="Boolean" locid="WinJS.Utilities.strictProcessing" helpKeyword="WinJS.Utilities.strictProcessing">Determines if strict declarative processing is enabled in this script context.</field>
        strictProcessing: {
            get: function () { return true; },
            configurable: false,
            enumerable: true,
        },

        markSupportedForProcessing: {
            value: _BaseCoreUtils.markSupportedForProcessing,
            configurable: false,
            writable: false,
            enumerable: true
        },

        requireSupportedForProcessing: {
            value: function (value) {
                /// <signature helpKeyword="WinJS.Utilities.requireSupportedForProcessing">
                /// <summary locid="WinJS.Utilities.requireSupportedForProcessing">
                /// Asserts that the value is compatible with declarative processing, such as WinJS.UI.processAll
                /// or WinJS.Binding.processAll. If it is not compatible an exception will be thrown.
                /// </summary>
                /// <param name="value" type="Object" locid="WinJS.Utilities.requireSupportedForProcessing_p:value">
                /// The value to be tested for compatibility with declarative processing. If the
                /// value is a function it must be marked with a property 'supportedForProcessing'
                /// with a value of true.
                /// </param>
                /// <returns type="Object" locid="WinJS.Utilities.requireSupportedForProcessing_returnValue">
                /// The input value.
                /// </returns>
                /// </signature>
                var supportedForProcessing = true;

                supportedForProcessing = supportedForProcessing && value !== _Global;
                supportedForProcessing = supportedForProcessing && value !== _Global.location;
                supportedForProcessing = supportedForProcessing && !(value instanceof _Global.HTMLIFrameElement);
                supportedForProcessing = supportedForProcessing && !(typeof value === "function" && !value.supportedForProcessing);

                switch (_Global.frames.length) {
                    case 0:
                        break;

                    case 1:
                        supportedForProcessing = supportedForProcessing && value !== _Global.frames[0];
                        break;

                    default:
                        for (var i = 0, len = _Global.frames.length; supportedForProcessing && i < len; i++) {
                            supportedForProcessing = supportedForProcessing && value !== _Global.frames[i];
                        }
                        break;
                }

                if (supportedForProcessing) {
                    return value;
                }

                throw new _ErrorFromName("WinJS.Utilities.requireSupportedForProcessing", _Resources._formatString(strings.notSupportedForProcessing, value));
            },
            configurable: false,
            writable: false,
            enumerable: true
        },
        
        _setImmediate: _BaseCoreUtils._setImmediate,
        
        // Allows the browser to finish dispatching its current set of events before running
        // the callback.
        _yieldForEvents: _Global.setImmediate ? _Global.setImmediate.bind(_Global) : function (handler) {
            _Global.setTimeout(handler, 0);
        },
        
        // Allows the browser to notice a DOM modification before running the callback.
        _yieldForDomModification: _Global.setImmediate ? _Global.setImmediate.bind(_Global) : function (handler) {
            _Global.setTimeout(handler, 0);
        },

        _shallowCopy: function _shallowCopy(a) {
            // Shallow copy a single object.
            return this._mergeAll([a]);
        },

        _merge: function _merge(a, b) {
            // Merge 2 objects together into a new object
            return this._mergeAll([a, b]);
        },

        _mergeAll: function _mergeAll(list) {
            // Merge a list of objects together
            var o = {};
            list.forEach(function (part) {
                Object.keys(part).forEach(function (k) {
                    o[k] = part[k];
                });
            });
            return o;
        },
        
        _getProfilerMarkIdentifier: function _getProfilerMarkIdentifier(element) {
            var profilerMarkIdentifier = "";
            if (element.id) {
                profilerMarkIdentifier += " id='" + element.id + "'";
            }
            if (element.className) {
                profilerMarkIdentifier += " class='" + element.className + "'";
            }
            return profilerMarkIdentifier;
        },

        _now: function _now() {
            return (_Global.performance && _Global.performance.now()) || Date.now();
        },

        _traceAsyncOperationStarting: _Trace._traceAsyncOperationStarting,
        _traceAsyncOperationCompleted: _Trace._traceAsyncOperationCompleted,
        _traceAsyncCallbackStarting: _Trace._traceAsyncCallbackStarting,
        _traceAsyncCallbackCompleted: _Trace._traceAsyncCallbackCompleted,

        /// <field type="Boolean" locid="WinJS.Utilities.isPhone" helpKeyword="WinJS.Utilities.isPhone">Determine if we are currently running in the Phone.</field>
        isPhone: {
            get: function () { return isPhone; },
            configurable: false,
            enumerable: true
        },
        _setIsPhone: {
            set: function(value) {
                isPhone = value;
            }
        }
    });

    _Base.Namespace._moduleDefine(exports, "WinJS", {
        validation: {
            get: function() {
                return validation;
            },
            set: function(value) {
                validation = value;
            }
        }
    });

    // strictProcessing also exists as a module member
    _Base.Namespace.define("WinJS", {
        strictProcessing: {
            value: function () {
                /// <signature helpKeyword="WinJS.strictProcessing">
                /// <summary locid="WinJS.strictProcessing">
                /// Strict processing is always enforced, this method has no effect.
                /// </summary>
                /// </signature>
            },
            configurable: false,
            writable: false,
            enumerable: false
        }
    });
});


define('WinJS/Core',[
    './Core/_Base',
    './Core/_BaseCoreUtils',
    './Core/_BaseUtils',
    './Core/_ErrorFromName',
    './Core/_Events',
    './Core/_Global',
    './Core/_Log',
    './Core/_Resources',
    './Core/_Trace',
    './Core/_WinRT',
    './Core/_WriteProfilerMark'
    ], function() {
    // Wrapper module
});

// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
/* global WinJS */
define('WinJS-custom',[
    'WinJS/Core',
    'WinJS/Promise',
    ], function() {
    "use strict";

    return WinJS;
});
// Copyright (c) Microsoft Open Technologies, Inc.  All Rights Reserved. Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
    return require('WinJS-custom');
}));
WinJS.Utilities._writeProfilerMark("WinJS.2.1 2.0.1.WinJS.2014.7.15 WinJS.js,StopTM");