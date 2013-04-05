/* Copyright (c) 2012-2013 Brian Cavalier */
(function(define, global) {
define(function() {

	var avow, enqueue, defaultConfig, setTimeout, clearTimeout,
		bind, uncurryThis, call, apply, arrayProto, reduce, map,
		undef;

	bind = Function.prototype.bind;
	uncurryThis = bind.bind(bind.call);

	call = uncurryThis(bind.call);
	apply = uncurryThis(bind.apply);

	arrayProto = [];
	reduce = uncurryThis(arrayProto.reduce);
	map = uncurryThis(arrayProto.map);

	// Prefer setImmediate, cascade to node, vertx and finally setTimeout
	/*global setImmediate,process,vertx*/
	if(typeof vertx === 'object') {
		setTimeout = function (f, ms) { return vertx.setTimer(ms, f); };
		clearTimeout = vertx.cancelTimer;
	} else {
		setTimeout = global.setTimeout;
		clearTimeout = global.clearTimeout;
	}

	// Prefer setImmediate, cascade to node, vertx and finally setTimeout
	/*global setImmediate,process,vertx*/
	enqueue = typeof setImmediate === 'function' ? setImmediate.bind(global)
		: typeof process === 'object' ? process.nextTick // Node < 0.9
		: typeof vertx === 'object' ? vertx.runOnLoop // vert.x
			: function(task) { setTimeout(task, 0); }; // fallback

	// Default configuration
	defaultConfig = {
		enqueue:   enqueue,
		unhandled: noop,
		handled:   noop,
		protect:   noop
	};

	// Create the default module instance
	// This is what you get when you require('avow')
	avow = constructAvow(defaultConfig);

	// You can use require('avow').construct(options) to
	// construct a custom configured version of avow
	avow.construct = constructAvow;

	return avow;

	// This constructs configured instances of the avow module
	function constructAvow(config) {

		var enqueue, onHandled, onUnhandled, protect;

		// Grab the config params, use defaults where necessary
		enqueue     = config.enqueue   || defaultConfig.enqueue;
		onHandled   = config.handled   || defaultConfig.handled;
		onUnhandled = config.unhandled || defaultConfig.unhandled;
		protect     = config.protect   || defaultConfig.protect;

		// Add lift and reject methods.
		promise.lift    = lift;
		promise.reject  = reject;

		promise.all     = all;
		promise.any     = any;
		promise.settle  = settle;

		promise.fmap    = fmap;

		promise.delay   = delay;
		promise.timeout = timeout;

		return promise;

		// Return a trusted promise for x.  Where if x is a
		// - Promise, return it
		// - value, return a promise that will eventually fulfill with x
		// - thenable, assimilate it and return a promise whose fate follows that of x.
		function lift(x) {
			return promise(function(resolve) {
				resolve(x);
			});
		}

		// Return a rejected promise
		function reject(reason) {
			return promise(function(_, reject) {
				reject(reason);
			});
		}

		// Return a pending promise whose fate is determined by resolver
		function promise(resolver) {
			var self, value, handled, handlers = [];

			self = new Promise(then);

			// Call the resolver to seal the promise's fate
			try {
				resolver(promiseResolve, promiseReject);
			} catch(e) {
				promiseReject(e);
			}

			// Return the promise
			return self;

			// Register handlers with this promise
			function then(onFulfilled, onRejected) {
				if (!handled) {
					handled = true;
					onHandled(self);
				}

				return promise(function(resolve, reject) {
					handlers
						// Call handlers later, after resolution
						? handlers.push(function(value) {
							value.then(onFulfilled, onRejected).then(resolve, reject);
						})
						// Call handlers soon, but not in the current stack
						: enqueue(function() {
							value.then(onFulfilled, onRejected).then(resolve, reject);
						});
				});
			}

			// Resolve with a value, promise, or thenable
			function promiseResolve(value) {
				if(!handlers) {
					return;
				}

				resolve(coerce(value));
			}

			// Reject with reason verbatim
			function promiseReject(reason) {
				if(!handlers) {
					return;
				}

				if(!handled) {
					onUnhandled(self, reason);
				}

				resolve(rejected(reason));
			}

			// For all handlers, run the Promise Resolution Procedure on this promise
			function resolve(x) {
				var queue = handlers;
				handlers = undef;
				value = x;

				enqueue(function () {
					queue.forEach(function (handler) {
						handler(value);
					});
				});
			}
		}

		// Lists of promises

		// Return a promise that will fulfill after all promises in array
		// have fulfilled, or will reject after one promise in array rejects
		function all(array) {
			return lift(array).then(function(array) {
				return promise(function(resolve, reject) {
					var count, results = [];

					count = reduce(array, function(count, p, i) {
						lift(p).then(addResult.bind(undef, i), reject);
						return count + 1;
					}, 0);

					function addResult(index, x) {
						results[index] = x;
						if(!--count) {
							resolve(results);
						}
					}
				});
			});
		}

		// Return a promise that will fulfill after one promise in array
		// is fulfilled, or will reject after all promises in array have rejected
		function any(array) {
			return lift(array).then(function(array) {
				return promise(function(resolve, reject) {
					var count, results = [];

					count = reduce(array, function(count, p, i) {
						lift(p).then(resolve, addResult.bind(undef, i));
						return count + 1;
					}, 0);

					function addResult(index, x) {
						results[index] = x;
						if(!--count) {
							reject(results);
						}
					}
				});
			});
		}

		// Return a promise that will fulfill with an array of objects, each
		// with a 'value' or 'reason' property corresponding to the fulfillment
		// value or rejection reason of the
		function settle(array) {
			return lift(array).then(function(array) {
				return all(map(array, function(item) {
					return coerce(item).then(toValue, toReason);
				}));
			});
		}

		// Functions

		// Return a function that accepts promises as arguments and
		// returns a promise.
		function fmap(f) {
			return function() {
				return all(arguments).then(apply.bind(f, undef));
			};
		}

		// Timed promises

		// Return a promise that delays ms before resolving
		function delay(ms, result) {
			return promise(function(resolve) {
				setTimeout(resolve.bind(undef, result), ms);
			});
		}

		// Return a promise that will reject after ms if not resolved first
		function timeout(ms, trigger) {
			return promise(function(resolve, reject) {
				var handle = setTimeout(reject, ms);

				lift(trigger).then(
					function(value) {
						clearTimeout(handle);
						resolve(value);
					},
					function(reason) {
						clearTimeout(handle);
						reject(reason);
					}
				);
			});
		}

		// Private

		// Trusted promise constructor
		function Promise(then) {
			this.then = then;
			protect(this);
		}

		// Coerce x to a promise
		function coerce(x) {
			if(x instanceof Promise) {
				return x;
			} else if (x !== Object(x)) {
				return fulfilled(x);
			}

			return promise(function(resolve, reject) {
				enqueue(function() {
					try {
						// We must check and assimilate in the same tick, but not the
						// current tick, careful only to access promiseOrValue.then once.
						var untrustedThen = x.then;

						if(typeof untrustedThen === 'function') {
							call(untrustedThen, x, resolve, reject);
						} else {
							// It's a value, create a fulfilled wrapper
							resolve(fulfilled(x));
						}
					} catch(e) {
						// Something went wrong, reject
						reject(e);
					}
				});
			});
		}

		// create an already-fulfilled promise used to break assimilation recursion
		function fulfilled(x) {
			var self = new Promise(function (onFulfilled) {
				try {
					return typeof onFulfilled == 'function'
						? coerce(onFulfilled(x)) : self;
				} catch (e) {
					return rejected(e);
				}
			});

			return self;
		}

		// create an already-rejected promise
		function rejected(x) {
			var self = new Promise(function (_, onRejected) {
				try {
					return typeof onRejected == 'function'
						? coerce(onRejected(x)) : self;
				} catch (e) {
					return rejected(e);
				}
			});

			return self;
		}
	}

	function toValue(x) {
		return { value: x };
	}

	function toReason(x) {
		return { reason: x };
	}

	function noop() {}

});
})(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(); }, this);