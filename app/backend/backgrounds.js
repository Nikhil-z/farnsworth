'use strict';

const request = require('request');
const fs = require('fs');
const path = require('path');
const fsExtra = require('fs-extra');
const download = require('download');
const electron = require('electron');
const sha1 = require('sha1');
const debug = require('debug')('farnsworth:backgrounds');
const _ = require('lodash');

const app = electron.app;
const ipc = electron.ipcMain;

// URL where our backgrounds are
const BACKGROUND_URL = 'https://raw.githubusercontent.com/dconnolly/chromecast-backgrounds/master/backgrounds.json';
const BACKGROUNDS_SAVE_PATH = app.getPath('userData') + '/backgrounds.json';
const BACKGROUNDS_DIR = app.getPath('userData') + '/backgrounds';
const BACKGROUND_DOWNLOAD_THREADS = 4;

function cleanBackgrounds(backgrounds) {
    // Clean up any backgrounds we don't have in the list anymore.
    fs.readdir(BACKGROUNDS_DIR, function(error, files) {
        if(!error) {
            _.each(files, function(f) {
                if(!_.find(backgrounds, function(background) {
                    return f === background.filename;
                })) {
                    console.log(`Deleting ${f}`);

                    try {
                        fs.unlinkSync(path.join(BACKGROUNDS_DIR, f));
                    } catch(e) {}
                }
            });
        }
    });
}

// Download all of the available backgrounds locally just in case we
// need them when we don't have an internet connection.
function downloadBackgrounds() {
    var ready = false;

    ipc.on('background-service-ready', function(ev) {
        var bgService = ev.sender;

        function doDownload(backgrounds, index, bgAvailable) {
            return new Promise(function(resolve, reject) {
                if(index < backgrounds.length) {
                    if(backgrounds[index].downloaded) {
                        doDownload(backgrounds, index + 1, bgAvailable).then(resolve, reject);
                    } else {
                        // Since the URLs contain a variety of filenames, for easiest
                        // portability, we're just going to generate a new filename
                        // based on the sha1 hash of the URL. Overkill? Maybe.
                        // Problematic for other reasons? Also possible.
                        //
                        // As one of the dads would say: "Good enough for who it's for."
                        debug(' - Downloading...');
                        backgrounds[index].filename = `${sha1(backgrounds[index].url)}${path.extname(backgrounds[index].url)}`;
                        var filename = path.join(BACKGROUNDS_DIR, backgrounds[index].filename);

                        console.log(`Downloading ${backgrounds[index].url} to ${filename}...`);
                        download(backgrounds[index].url)
                            .pipe(fs.createWriteStream(filename))
                            .on('close', function() {
                                // Set the probably unnecessary downloaded flag to true.
                                backgrounds[index].downloaded = true;

                                // If we haven't told the renderer that a bg is available, do
                                // so now.
                                if(!bgAvailable) {
                                    bgAvailable = true;
                                    debug(`Notifying renderer that background ${backgrounds[index].filename} is available.`);
                                    bgService.send('background-available', backgrounds[index], index);
                                }

                                bgService.send('background-data-available', backgrounds);

                                // Save the backgrounds file. Possibly a minor performance impact
                                // serializing JSON and writing to disk every time we download an
                                // image but...see above dad quote.
                                fs.writeFile(BACKGROUNDS_SAVE_PATH, JSON.stringify(backgrounds, null, 4), function(error) {
                                    if(error) {
                                        bgWindow.send('backgrounds-error', 'Could not save backgrounds list', error);
                                    }

                                    doDownload(backgrounds, index + 1, bgAvailable).then(resolve, reject);
                                });
                            }).on('error', function(error) {
                                console.log(`Error downloading ${backgrounds[index].url}:`, error);
                                bgWindow.send('backgrounds-error', `Error downloading ${backgrounds[index].url}`, error);
                                doDownload(backgrounds, index + 1, bgAvailable).then(resolve, reject);
                            });
                    }
                } else {
                    // Resolve only when we've processed all images.
                    debug('Completed all files, resolving.');
                    resolve();
                }
            });
        }

        console.log('Loading background images...');

        // Try to be as quick as possible finding the first background.
        // First, see if we already have background data.
        var waitForPrep = new Promise(function(resolve, reject) {
            fs.readFile(BACKGROUNDS_SAVE_PATH, function(error, data) {
                var backgrounds = null;
                var bgAvailable = false;

                if(!error) {
                    debug('Found existing backgrounds file, loading...');

                    // We do, try and load it and, if successful, tell the
                    // renderer that we have data and look for an actual
                    // downloaded image file. If we have at least one, let
                    // the renderer know we're ready to go.
                    try {
                        backgrounds = JSON.parse(data);

                        debug(`Loaded ${backgrounds.length} backgrounds in data file.`);

                        new Promise(function(resolve, reject) {
                            fs.readdir(BACKGROUNDS_DIR, function(error, entries) {
                                if(error) {
                                    if(error.code === 'ENOENT') {
                                        resolve([]);
                                    } else {
                                        reject(`Unable to access background directory ${BACKGROUNDS_DIR}:`, error);
                                    }
                                } else {
                                    resolve(entries);
                                }
                            })
                        }).then(function(entries) {
                            debug('Filtering missing backgrounds...');
                            backgrounds = _.filter(backgrounds, function(background) {
                                return entries.indexOf(background.filename) !== -1;
                            });

                            debug(`Filtered down to ${backgrounds.length} backgrounds on disk.`);

                            if(backgrounds.length > 0) {
                                bgService.send('background-data-available', backgrounds);
                            }
                            
                            entries = _.filter(entries, function(entry) {
                                return _.findIndex(backgrounds, function(background) {
                                    return entry === background.filename;
                                }) === -1;
                            });

                            if(entries.length > 0) {
                                debug(`Removing ${entries.length} remaining backgrounds...`);
                                cleanBackgrounds(backgrounds);
                            }

                            var background = _.findIndex(backgrounds, function(entry) {
                                if(!entry.downloaded || !entry.filename)  {
                                    return false;
                                }

                                try {
                                    fs.accessSync(path.join(BACKGROUNDS_DIR, entry.filename), fs.R_OK);
                                    return true;
                                } catch(e) {
                                    return false;
                                }
                            });

                            if(background !== -1) {
                                debug('Found at least one available background image, notifying renderer.');
                                bgAvailable = true;
                                bgService.send('background-available', backgrounds[background]);
                            }

                            resolve(backgrounds, bgAvailable);
                        }, function(error, details) {
                            console.log(error, details);
                            resolve(null, bgAvailable);
                        });
                    } catch(e) {
                        resolve(null, bgAvailable);
                    }
                } else {
                    resolve(null, bgAvailable);
                }
            });

            // Now, load up the background file from the URL and, if successful,
            // save it or update ours by adding new backgrounds and removing those
            // that don't exist.
            debug(`Loading updated background data from URL ${BACKGROUND_URL}...`);
            request(BACKGROUND_URL, function(error, response, body) {
                if(error || response.statusCode !== 200) {
                    console.error('Error loading backgrounds from ' + BACKGROUND_URL, error);
                    bgService.send('backgrounds-error', 'Error loading backgrounds from ' + BACKGROUND_URL, error);
                } else {
                    var newBgData = JSON.parse(body);

                    waitForPrep.then(function(backgrounds, bgAvailable) {
                        // If we already have data, go through it and update it with
                        // data from the server.
                        if(backgrounds !== null) {
                            debug(`Updating data with new entries from remote. Existing count: ${backgrounds.length}, remote length: ${newBgData.length}`);
                            _.each(newBgData, function(entry) {
                                if(!_.find(backgrounds, function(existing) {
                                    return entry.url === existing.url;
                                })) {
                                    backgrounds.push(entry);
                                }
                            });

                            debug(`New count: ${backgrounds.length}, removing backgrounds that have been removed from remote.`);
                            _.remove(backgrounds, function(entry) {
                                return !_.find(newBgData, function(newEntry) {
                                    return newEntry.url === entry.url;
                                });
                            });
                        } else {
                            backgrounds = newBgData;
                        }

                        debug(`Total backgrounds: ${backgrounds.length}`);

                        // Notify the renderer that new data is available. Even
                        // though we've already notified them once, give them
                        // a chance to deal with new data being available.
                        bgService.send('background-data-available', backgrounds);

                        // Save the background file locally.
                        fs.writeFile(BACKGROUNDS_SAVE_PATH, JSON.stringify(backgrounds, null, 4), function(error) {
                            if(error) {
                                bgWindow.send('backgrounds-error', 'Could not save backgrounds list', error);
                            }
                        });

                        // Create the backgrounds directory
                        fsExtra.mkdirs(BACKGROUNDS_DIR, function(error) {
                            if(error) {
                                console.error('Could not create directory for backgrounds: ', error);
                                bgService.send('backgrounds-error', 'Could not create directory for backgrounds', error);
                            } else {
                                // Download all of the background images, succeeding whether or not
                                // the promise resolves or rejects.
                                doDownload(backgrounds, 0, bgAvailable).then(function() {
                                    debug(`Background downloading succeeded.`);
                                    bgService.send('backgrounds-downloaded');

                                    cleanBackgrounds(backgrounds);
                                }, function(error) {
                                    bgService.send('backgrounds-error', `Unhandled error downloading backgrounds: ${error}`);
                                    throw error;
                                });
                            }
                        });
                    }, function(error, details) {
                        bgService.send('backgrounds-error', error, details);
                    });
                }
            });
        });
    });
}

module.exports = downloadBackgrounds;
