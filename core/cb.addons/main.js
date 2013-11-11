var _ = require('underscore');
var Q = require("q");
var fs  =  require('fs');
var path = require('path');
var express = require('express');
var Gittle = require('gittle');
var Gift = require('gift');
var temp = require('temp');
var wrench = require('wrench');
var requirejs = require('requirejs');
var exec = require('child_process').exec;

function setup(options, imports, register, app) {
    var logger = imports.logger.namespace("addons");
    var server = imports.server;
    var events = imports.events;
    var hooks = imports.hooks;

    // Addons paths
    var defaultsPath = path.resolve(options.defaultsPath);
    var addonsPath = path.resolve(options.path);
    var tempPath = options.tempPath ? path.resolve(options.tempPath) : null;
    if (!fs.existsSync(addonsPath)) {
        wrench.mkdirSyncRecursive(addonsPath);
    }

    // Valid a package.json info
    var validPackage = function(addon) {
        return !(!addon.name || !addon.version
            || (!addon.main && !addon.client && !addon.client.main));
    }

    // Check if an addons is a default addons
    var isDefaultAddon = function(addon) {
        return fs.existsSync(path.join(defaultsPath, addon));
    };

    // Check if an addon is client side
    var isClientside = function(addon) {
        return (addon.client && addon.client);
    };

    // Load addons list
    var loadAddonsInfos = function() {
        var addons = {};

        // Read addons directory
        return Q.nfcall(fs.readdir, addonsPath).then(function(dirs) {
            dirs.forEach(function (dir) {
                if (dir.indexOf('.') == 0) return;

                packageJsonFile = addonsPath + '/' + dir + '/package.json';
                if (!fs.existsSync(packageJsonFile)) return;
                addon = JSON.parse(fs.readFileSync(packageJsonFile, 'utf8'));

                if (!validPackage(addon)) {
                    return;
                }
                addon.default = isDefaultAddon(addon.name);
                addons[dir] = addon;
            });

            return Q(addons);
        });
    };

    // Initialize a node addon
    // Caution: be sure it's a node addon
    var initNodeAddon = function(addon) {
        var addonPath = path.resolve(addonsPath + '/' + addon + '/');
        logger.log("addon", addon, "is a node addon:", addonPath);
        return app.load([
            {
                packagePath: addonPath
            }
        ]);
    }

    // Optimize client addon
    var optimizeAddon = function(addon) {
        var d = Q.defer();

        if (!isClientside(addon)) {
            return Q.reject(new Error("Not a cleint side addon"));
        }

        // R.js bin
        var rjs = path.resolve(__dirname, "../../node_modules/.bin/r.js");

        // Base directory for the addon
        var addonPath = path.resolve(addonsPath + '/' + addon.name + '/');

        // Path to the require-tools
        var requiretoolsPath = path.resolve(__dirname, "../../client/build/static/require-tools");

        // Base main
        var main = addon.client.main;

        // Output file
        var output = path.resolve(addonPath, "addon-built.js");

        // Build config
        var optconfig = {
            'baseUrl': addonPath,
            'name': main,
            'out': output,
            'paths': {
                'require-tools': requiretoolsPath
            },
            'optimize': "none",
            'map': {
                '*': {
                    'css': "require-tools/css/css",
                    'less': "require-tools/less/less"
                }
            }
        };

        var command = rjs+" -o baseUrl="+addonPath+" paths.require-tools="+requiretoolsPath+" name="+main+" map.*.css=require-tools/css/css map.*.less=require-tools/less/less out="+output;

        // Run optimization
        logger.log("Optimizing", addon.name);
        return Q.nfcall(exec, command).then(function() {
            logger.log("Finished", addon.name, "optimization");
            return Q(output);
        }, function(err) {
            logger.error("error for",addon.name);
            logger.exception(err, false);
            return Q.reject(err);
        });
    };

    // Initialize node addons
    var initNodeAddons = function() {
        logger.log("Load node addons");
        return loadAddonsInfos().then(function(addons) {
            return Q.all(_.map(addons, function(addon) {
                if (!addon.main) return;
                return initNodeAddon(addon.name);
            }));
        });  
    };

    // Optimize client addons
    var optimzeClientsAddons = function() {
        logger.log("Optimize client addons");
        return loadAddonsInfos().then(function(addons) {
            return Q.all(_.map(addons, function(addon) {
                if (!isClientside(addon)) return;
                return optimizeAddon(addon);
            }));
        });  
    };

    // Install dependencies for an addon
    var installDependencies = function(addon) {
        var addonDir = path.join(addonsPath, addon);
        logger.log("Install dependencies ", addonDir);
        return Q.nfcall(exec, "cd "+addonDir+" && npm install .");
    };

    // Install an addon by its git url
    var installAddon = function(git, options) {
        var addon, tempDir, addonDir;

        options = _.defaults({}, options || {}, {
            'reload': true
        });

        logger.log("Install add-on", git);

        var createTempDirectory = function() {
            if (!tempPath) {
                return Q.nfcall(temp.mkdir, 'addons');
            } else {
                var ret = path.join(tempPath, "t"+Date.now());
                return Q.nfcall(fs.mkdir, ret).then(function() {
                    return Q(ret);
                });
            }
        };

        // Create temporary dir
        return createTempDirectory().then(function(dirPath) {
            // Clone git repo
            tempDir = dirPath;
            return Q.nfcall(Gift.clone, git, tempDir);
        }).then(function(repo) {
            // Check addon
            var packageJsonFile = path.join(tempDir, "package.json");
            if (!fs.existsSync(packageJsonFile)) {
                throw new Error("No 'package.json' in this repository");
            }
            addon = JSON.parse(fs.readFileSync(packageJsonFile, 'utf8'));
            if (!validPackage(addon)) {
                throw new Error("Invalid 'package.json' file");
            }

            // Copy temp dir to addons dir
            addonDir = path.join(addonsPath, addon.name);

            // Valid installation of addon with a hook
            return hooks.use("addons", addon);
        }).then(function() {
            // Copy to addons dir
            return Q.nfcall(wrench.copyDirRecursive, tempDir, addonDir, {forceDelete: true});
        }).then(function() {
            // Remove temporary dir
            return Q.nfcall(wrench.rmdirRecursive, tempDir, false);
        }).then(function() {
            // If client side addon then optimize it
            if (!isClientside(addon)) return;
            return optimizeAddon(addon);
        }).then(function() {
            // Install node dependencies
            return installDependencies(addon.name);
        }).then(function() {
            // If node addon them initialize it
            if (!addon.main) return;
            return initNodeAddon(addon.name);
        }).then(function(stdout, stderr) {
            // Reload addons
            if (!options.reload) {
                return;
            }
            return loadAddonsInfos();
        }).then(function() {
            // Emit events
            events.emit('addons.install', addon);

            // Return addon infos
            return Q(addon);
        });
    };

    // Uninstall an addon
    var uninstallAddon = function(name) {
        var addonDir = path.join(addonsPath, name);
        logger.log("Uninstall add-on", name);
        if (isDefaultAddon(name)) {
            return Q.reject(new Error("Cannot uninstall a default addon"));
        }
        return Q.nfcall(wrench.rmdirRecursive, addonDir, false).then(function() {
            // Emit events
            events.emit('addons.uninstall', {
                'name': name
            });

            return Q(true);
        });
    };

    // Install default addons
    var installDefaults = function() {
        return Q.nfcall(fs.readdir, defaultsPath).then(function(dirs) {
            return Q.allSettled(_.map(dirs, function(dir) {
                var defaultAddon = path.join(defaultsPath, dir);
                var addonPath = path.join(addonsPath, dir);

                return Q.nfcall(fs.lstat, defaultAddon).then(function(stat) {
                    if (stat.isDirectory()) {
                        return Q();
                    } else {
                        throw new Error("There is a file inside defaults addons directory: "+defaultAddon);
                    }
                }).then(function() {
                    logger.log("update default addon", addonPath);
                    return Q.nfcall(wrench.copyDirRecursive, defaultAddon, addonPath, {
                        forceDelete: true,
                        excludeHiddenUnix: false,
                        preserveFiles: false
                    }).then(function() {
                        // Install node dependences
                        return installDependencies(dir);
                    });
                });
            }));
        });
    };

    // Init addons
    server.app.use('/static/addons', express.static(addonsPath));

    // Install defaults addons if addons diretcory is empty
    logger.log("init addons");
    installDefaults().then(function() {
        logger.log("end of addons installation");
    }, function(err) {
        logger.error("Error with init of addons:");
        logger.exception(err, false);
    }).fin(optimzeClientsAddons).then(function() {
        return initNodeAddons()
    }).then(function() {
        logger.log("Addons are ready");
        register(null, {
            'addons': {
                'list': loadAddonsInfos,
                'install': installAddon,
                'uninstall': uninstallAddon
            }
        });
    }, function(err) {
        logger.error("Error with external node addons:");
        logger.exception(err);
    });
};

// Exports
module.exports = setup;