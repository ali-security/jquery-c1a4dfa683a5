/*
 * Headless QUnit runner for the jQuery test suite (PhantomJS 2.x).
 *
 * Usage:
 *   phantomjs test/run-qunit.js [url] [timeoutSeconds]
 *
 * Defaults to http://127.0.0.1:8000/test/index.html with a 15 minute timeout
 * (the same per-run timeout the TestSwarm task uses). The test pages must be
 * served by a web server that executes the PHP fixtures in test/data, e.g.
 * the one started by test/start-test-server.sh.
 *
 * Prints one line per failing assertion, one line per module and a final
 * summary. Exits 0 only when every assertion passed; exits 1 on any failure,
 * on timeout, on a page load failure or when no assertions ran.
 * Set QUNIT_VERBOSE=1 to also print the name of every test as it starts.
 */
/* jshint node: true */
/* global phantom: false */
(function() {

"use strict";

var system = require( "system" ),
	page = require( "webpage" ).create(),
	url = system.args[ 1 ] || "http://127.0.0.1:8000/test/index.html",
	timeoutSeconds = parseInt( system.args[ 2 ], 10 ) || 15 * 60,
	verbose = !!system.env.QUNIT_VERBOSE,
	opened = false,
	finished = false,
	started = false,
	pending = {},
	failedAssertions = 0,
	failedTests = 0,
	totalTests = 0;

function print( line ) {
	system.stdout.writeLine( line );
}

function finish( code ) {
	if ( finished ) {
		return;
	}
	finished = true;

	// Exiting from inside a page callback can crash PhantomJS 2; defer it.
	setTimeout(function() {
		phantom.exit( code );
	}, 0 );
}

page.viewportSize = { width: 1280, height: 1024 };

page.onConsoleMessage = function( msg ) {
	print( "CONSOLE: " + msg );
};

page.onResourceRequested = function( req ) {
	pending[ req.id ] = req.url;
};

page.onResourceReceived = function( res ) {
	if ( res.stage === "end" ) {
		delete pending[ res.id ];
	}
};

page.onResourceError = function( err ) {
	delete pending[ err.id ];
	print( "RESOURCE ERROR: " + err.url + " (" + err.errorCode + " " + err.errorString + ")" );
};

page.onResourceTimeout = function( req ) {
	print( "RESOURCE TIMEOUT: " + req.url );
};

page.onError = function( msg ) {
	// Uncaught errors are also reported by QUnit itself (as failing
	// assertions) when they happen during a test; just log them here.
	print( "PAGE ERROR: " + msg );
};

page.onCallback = function( data ) {
	var line;

	if ( !data || !data.type ) {
		return;
	}

	switch ( data.type ) {
	case "testStart":
		started = true;
		if ( verbose ) {
			print( "START: " + data.module + " :: " + data.name );
		}
		break;

	case "log":
		if ( !data.result ) {
			failedAssertions++;
			line = "FAIL: " + data.module + " :: " + data.name +
				( data.message ? " :: " + data.message : "" );
			if ( data.hasExpected ) {
				line += " (expected: " + data.expected + ", actual: " + data.actual + ")";
			}
			print( line );
			if ( data.source ) {
				print( "      " + data.source.split( "\n" ).slice( 0, 3 ).join( "\n      " ) );
			}
		}
		break;

	case "testDone":
		totalTests++;
		if ( data.failed ) {
			failedTests++;
			print( "FAILED TEST: " + data.module + " :: " + data.name +
				" (" + data.failed + " of " + data.total + " assertions failed)" );
		}
		break;

	case "moduleDone":
		print( "Module " + data.name + ": " + data.total + " assertions, " +
			data.passed + " passed, " + data.failed + " failed" );
		break;

	case "done":
		print( "Tests completed in " + data.runtime + "ms: " + data.total + " assertions, " +
			data.passed + " passed, " + data.failed + " failed (" + totalTests + " tests, " +
			failedTests + " failed)" );
		print( "Tests completed: " + data.total + " assertions, " + data.passed +
			" passed, " + data.failed + " failed (" + totalTests + " tests)" );
		finish( data.failed === 0 && data.total > 0 && failedAssertions === 0 ? 0 : 1 );
		break;
	}
};

// Hook the QUnit logging callbacks the moment qunit.js assigns window.QUnit,
// before any test can start (tests are loaded asynchronously via require.js).
page.onInitialized = function() {
	page.evaluate(function() {
		/* jshint browser: true */
		if ( window.__qunitRunnerHooked || window.parent !== window ) {
			return;
		}
		window.__qunitRunnerHooked = true;

		// PhantomJS 2.1.1 (QtWebKit) segfaults when several asynchronous
		// body-less POST requests are in flight at once (xhr.send() / send(null)).
		// Sending an empty string instead is equivalent on the wire and avoids
		// the crash; jQuery itself is not touched.
		(function() {
			var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype,
				open = proto && proto.open,
				send = proto && proto.send;

			if ( !open || !send ) {
				return;
			}
			proto.open = function( method ) {
				this.__runnerMethod = String( method ).toUpperCase();
				return open.apply( this, arguments );
			};
			proto.send = function( body ) {
				if ( body == null && this.__runnerMethod !== "GET" &&
						this.__runnerMethod !== "HEAD" ) {
					return send.call( this, "" );
				}
				return send.apply( this, arguments );
			};
		})();

		function dump( value ) {
			try {
				return String( window.QUnit.jsDump.parse( value ) );
			} catch ( e ) {
				return String( value );
			}
		}

		function hook( QUnit ) {
			QUnit.log(function( details ) {
				if ( details.result ) {
					return;
				}
				window.callPhantom({
					type: "log",
					result: details.result,
					module: details.module,
					name: details.name,
					message: details.message ? String( details.message ) : "",
					hasExpected: details.hasOwnProperty( "expected" ),
					expected: dump( details.expected ),
					actual: dump( details.actual ),
					source: details.source || ""
				});
			});
			QUnit.testStart(function( details ) {
				window.callPhantom({
					type: "testStart",
					module: details.module,
					name: details.name
				});
			});
			QUnit.testDone(function( details ) {
				window.callPhantom({
					type: "testDone",
					module: details.module,
					name: details.name,
					failed: details.failed,
					passed: details.passed,
					total: details.total
				});
			});
			QUnit.moduleDone(function( details ) {
				window.callPhantom({
					type: "moduleDone",
					name: details.name,
					failed: details.failed,
					passed: details.passed,
					total: details.total
				});
			});
			QUnit.done(function( details ) {
				window.callPhantom({
					type: "done",
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					runtime: details.runtime
				});
			});
		}

		Object.defineProperty( window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				return undefined;
			},
			set: function( QUnit ) {
				delete window.QUnit;
				window.QUnit = QUnit;
				hook( QUnit );
			}
		});
	});
};

print( "Opening " + url + " (timeout " + timeoutSeconds + "s)" );

page.open( url, function( status ) {
	// Only the first (main page) load result matters
	if ( opened ) {
		return;
	}
	opened = true;
	print( "Page load status: " + status );

	if ( status !== "success" ) {
		print( "ERROR: unable to load " + url + " (" + status + ")" );
		finish( 1 );
	}
});

// PhantomJS 2.1.1 occasionally never finishes loading the page, so QUnit never
// starts. Report the requests still in flight and exit with code 2 so the
// caller can retry with a fresh process. This only fires when NO test has
// started; any test failure still exits 1.
setTimeout(function() {
	var id;
	if ( started || finished ) {
		return;
	}
	print( "STALL: no QUnit test started within 90s; requests still pending:" );
	for ( id in pending ) {
		print( "  " + pending[ id ] );
	}
	finished = true;
	setTimeout(function() {
		phantom.exit( 2 );
	}, 0 );
}, 90000 );

// Heartbeat so a stalled run is visible (and CI no-output watchdogs don't fire first)
setInterval(function() {
	print( "... still running: " + totalTests + " tests done, " + failedAssertions + " failed assertions" );
}, 30000 );

setTimeout(function() {
	print( "ERROR: timed out after " + timeoutSeconds + "s waiting for QUnit to finish" );
	finish( 1 );
}, timeoutSeconds * 1000 );

})();
