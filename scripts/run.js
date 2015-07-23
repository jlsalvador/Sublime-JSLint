/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/
 */

/*jslint node: true, nomen: true*/
(function () {
    "use strict";

    var path = require("path"),
        fs = require("fs"),
        json_minify = require("node-json-minify"),
        jslint = require("./jslint.js").jslint,
        doLint = function (data, options, globals, lineOffset, charOffset) {

            // Globals to JSLint
            var globalList = [],
                result = [],
                global,
                oldLinter = false,
                errors;

            for (global in globals) {
                if (globals.hasOwnProperty(global)) {
                    globalList.push(global);
                }
            }

            // Lint the code and write readable error output to the console.
            try {
                result = jslint(data, options, globalList);
            } catch (ignore) {}

            if (jslint.errors) {
                oldLinter = true;
                errors = jslint.errors;
            } else {
                errors = result.warnings;
            }
            errors.forEach(function (e) {

                // If the argument is null, then we could not continue (too many errors).
                if (!e) {
                    return;
                }

                // Do some formatting if the error data is available.
                if (e.raw) {
                    if (e.raw === "Expected '{a}' at column {b}, not column {c}.") {
                        e.b += charOffset;
                        e.c += charOffset;
                    }
                    e.message = e.raw
                        .replace("{a}", e.a)
                        .replace("{b}", e.b)
                        .replace("{c}", e.c)
                        .replace("{d}", e.d);
                }

                if (!oldLinter) {
                    lineOffset += 1;
                    charOffset += 1;
                    e.character = e.column;
                }
                console.log([e.line + lineOffset, e.character + charOffset, e.message].join(" :: "));

            });
        },
        isTrue = function (value) {
            return value === "true" || value === true;
        },
        mergeOptions = function (source, target) {
            var entry;
            for (entry in source) {
                if (source.hasOwnProperty(entry)) {
                    if (entry === "globals") {
                        if (!target[entry]) {
                            target[entry] = {};
                        }
                        mergeOptions(source[entry], target[entry]);
                    } else {
                        target[entry] = source[entry];
                    }
                }
            }
        },
        parseJSON = function (file) {
            try {
                var baseFile,
                    baseOptions,
                    options = JSON.parse(json_minify(fs.readFileSync(file, "utf8")));
                if (!options.extends) {
                    return options;
                }
                // Get the options from base file.
                baseFile = options.extends;
                file = path.resolve(path.dirname(file), baseFile);
                baseOptions = parseJSON(file);
                // Overwrite base options with local options.
                delete options.extends;
                mergeOptions(options, baseOptions);
                return baseOptions;
            } catch (e) {
                console.log("Could not parse JSON at: " + file);
                return {};
            }
        },
        setOptions = function (file, isPackageJSON, optionsStore, globalsStore) {
            var key,
                value,
                i,
                index,
                name,
                obj = parseJSON(file);

            // Handle jslintConfig on package.json (NPM) files
            if (isPackageJSON) {
                if (obj.jslintConfig) {
                    obj = obj.jslintConfig;
                } else {
                    return false;
                }
            }

            for (key in obj) {
                if (obj.hasOwnProperty(key)) {
                    value = obj[key];

                    // Globals are defined as either an array, or an object with keys as names,
                    // and a boolean value to determine if they are assignable.
                    if (key === "globals" || key === "predef") {
                        if (value instanceof Array) {
                            for (i = 0; i < value.length; i += 1) {
                                name = value[i];
                                globalsStore[name] = true;
                            }
                        } else {
                            for (index in value) {
                                if (value.hasOwnProperty(index)) {
                                    globalsStore[index] = isTrue(value[index]);
                                }
                            }
                        }
                    } else {
                        // Special case "true" and "false" pref values as actually booleans.
                        // This avoids common accidents in .jslintrc json files.
                        if (value === "true" || value === "false") {
                            optionsStore[key] = isTrue(value);
                        } else {
                            optionsStore[key] = value;
                        }
                    }
                }
            }

            // Options were set successfully.
            return true;
        },
        tempPath = process.argv[2] || "", // The source file to be linted.
        filePath = process.argv[3] || "", // The original source's path.
        pluginFolder = path.dirname(__dirname),
        sourceFolder = path.dirname(filePath),
        options = {},
        globals = {},
        jslintrcPath = pluginFolder + (path.sep || "/") + ".jslintrc",
        packagejsonPath;

    // Try and get some persistent options from the plugin folder.
    fs.exists(jslintrcPath, function (exists) {
        if (exists) {
            setOptions(jslintrcPath, false, options, globals);
        }

        // When a JSLint config file exists in the same directory as the source file,
        // any directory above, or the user's home folder, then use that configuration
        // to overwrite the default prefs.
        path.sep = path.sep || "/";
        var sourceFolderParts = path.resolve(sourceFolder).split(path.sep),
            pathsToLook = sourceFolderParts.map(function (value, key) {
                return sourceFolderParts.slice(0, key + 1).join(path.sep);
            });

        // Start with the current directory first, end with the user's home folder.
        pathsToLook.reverse();
        pathsToLook.push(process.env.HOME || path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) || process.env.USERPROFILE);

        pathsToLook.some(function (pathToLook) {
            fs.existsSync = fs.existsSync || path.existsSync; // Older versions of node have `existsSync` in the `path` module, not `fs`. Meh.
            jslintrcPath = path.join(pathToLook, ".jslintrc");
            if (fs.existsSync(jslintrcPath)) {
                return setOptions(jslintrcPath, false, options, globals);
            }
            packagejsonPath = path.join(pathToLook, "package.json");
            if (fs.existsSync(packagejsonPath)) {
                return setOptions(packagejsonPath, true, options, globals);
            }
        });

        // Dump some diagnostics messages, parsed out by the plugin.
        console.log("Using JSLint globals: " + JSON.stringify(globals));
        console.log("Using JSLint options: " + JSON.stringify(options, null, 2));

        // Read the source file and, when done, lint the code.
        fs.readFile(tempPath, "utf8", function (err, data) {
            if (err) {
                return;
            }

            // Mark the output as being from JSLint.
            console.log("*** JSLint output ***");

            // First non whitespace character is &lt, so most definitely markup.
            var text, prevLines, lineOffset, isFirstLine, columnOffset, trunks,
                regexp = /<script[^>]*>([^]*?)<\/script\s*>/gim,
                script = regexp.exec(data);

            // If this is a markup file (html, xml, xhtml etc.), then javascript
            // is maybe present in a <script> tag. Try to extract it and lint.
            if (data.match(regexp)) {

                while (script !== null) {
                    isFirstLine = true;
                    // Script contents are captured at index 1.
                    text = script[1];

                    // Count all the lines up to and including the script tag.
                    prevLines = data.substr(0, data.indexOf(text)).split("\n");
                    lineOffset = prevLines.length - 1;
                    columnOffset = 0;

                    // Trim spaces left of the first line and cut the remaining lines
                    var trimSpacesLeftOfTheFirstLineAndCutTheRemainingLines = function (element, index) {
                        if (isFirstLine) {
                            if (element.length === 0) { return; }// Skip first empty lines
                            isFirstLine = false;
                            columnOffset = (element.match(/^ */) || [[]])[0].length;
                        }
                        trunks[index] = element.substring(columnOffset);
                    };
                    trunks = text.split('\n');
                    trunks.forEach(trimSpacesLeftOfTheFirstLineAndCutTheRemainingLines);
                    text = trunks.join('\n');

                    doLint(text, options, globals, lineOffset, columnOffset);
                    script = regexp.exec(data);
                }
            } else {
                doLint(data, options, globals, 0, 0);
            }
        });

    });

}());
