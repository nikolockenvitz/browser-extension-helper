const fs = require("fs");
const path = require("path");
const exec = require("child_process").exec;
const AdmZip = require("adm-zip");
const os = require("os");
const osPlatform = os.platform();

const README_BADGE_INSERT_START = "<!-- SHIELD IO BADGES INSTALL START -->";
const README_BADGE_INSERT_END = "<!-- SHIELD IO BADGES INSTALL END -->";

const CONSOLE_LOG_COLOR_FG_RED = "\x1b[31m";
const CONSOLE_LOG_COLOR_FG_GREEN = "\x1b[32m";
const CONSOLE_LOG_COLOR_RESET = "\x1b[0m";

const LIST_OF_COMMANDS = `
npm run help           logs this help
npm run dev -- fx      copies {FILEPATH_MANIFEST_FIREFOX} to manifest.json
npm run dev -- chrome  copies {FILEPATH_MANIFEST_CHROME} to manifest.json
npm run build          zips all files into {ZIP_FILENAME}
npm run build -- amo   + opens the AMO page to upload a new version for this addon
npm run build -- beta  + adds ' [beta]' to the addons name in the zips manifest
npm run deploy         adds xpi to updates.json and README.md + deletes previous versions
`;

const DIRECTORY_NAME_XPI = "xpi";
const FILEPATH_MANIFEST = "manifest.json";
const FILEPATH_UPDATES = "updates.json";
const FILEPATH_README = "README.md";

// name of current directory must match repository and addon name
let REPOSITORY_NAME = path.basename(process.cwd());
let URL_UPDATES = `https://nikolockenvitz.github.io/${REPOSITORY_NAME}`;
let AMO_URL;
let AMO_URL_BETA;
let ZIP_CONTENT;
let README_BADGE_TEXT;
let ZIP_FOLDERNAME;
let ZIP_FILENAME_INCLUDE_VERSION;
let FILEPATH_MANIFEST_FIREFOX;
let FILEPATH_MANIFEST_CHROME;

exports.init = function (options) {
    AMO_URL = options.amoURL;
    AMO_URL_BETA = options.amoURLbeta;
    ZIP_CONTENT = options.zipContent;
    README_BADGE_TEXT = options.readmeBadgeText;
    ZIP_FOLDERNAME = options.zipFoldername || ".";
    ZIP_FILENAME_INCLUDE_VERSION = options.zipFilenameIncludeVersion;
    FILEPATH_MANIFEST_FIREFOX = options.filepathManifestFirefox;
    FILEPATH_MANIFEST_CHROME = options.filepathManifestChrome;
};

exports.main = async function (argv) {
    const options = argv.slice(3);
    switch (argv[2]) {
        case "help":
            logListOfCommands();
            break;
        case "dev":
            copyManifest(options.includes("fx") ? FILEPATH_MANIFEST_FIREFOX : options.includes("chrome") ? FILEPATH_MANIFEST_CHROME : null);
            break;
        case "build":
            const isBeta = options.includes("beta");
            if (FILEPATH_MANIFEST_FIREFOX && FILEPATH_MANIFEST_CHROME) {
                await copyManifest(FILEPATH_MANIFEST_CHROME);
                await buildAddon(isBeta, "chrome");
                await copyManifest(FILEPATH_MANIFEST_FIREFOX);
                await buildAddon(isBeta, "fx");
            } else {
                await buildAddon(isBeta);
            }
            if (options.includes("amo")) {
                openAMOAddonUpload(isBeta);
            }
            break;
        case "deploy":
            deployAddon();
            break;
    }
};

function logListOfCommands() {
    logInfo(
        LIST_OF_COMMANDS.replace("{ZIP_FILENAME}", getZipFilename())
            .replace("{FILEPATH_MANIFEST_FIREFOX}", FILEPATH_MANIFEST_FIREFOX || "?")
            .replace("{FILEPATH_MANIFEST_CHROME}", FILEPATH_MANIFEST_CHROME || "?")
    );
}

async function copyManifest(filepath) {
    if (!filepath) throw new Error("Don't know which file to copy");
    return fs.promises.copyFile(filepath, FILEPATH_MANIFEST);
}

async function buildAddon(beta = false, zipFilenameSuffix = "") {
    // creates a .zip to be uploaded to AMO
    const manifest = await getManifest();
    const version = manifest.version;
    const zipFilename = getZipFilename(version, beta, zipFilenameSuffix);

    if (beta) {
        manifest.name += " [beta]";
        if (manifest.browser_action && manifest.browser_action.default_title) {
            manifest.browser_action.default_title += " [beta]";
        }
        if (manifest.action && manifest.action.default_title) {
            manifest.action.default_title += " [beta]";
        }
        await saveManifest(manifest);
    }

    await deletePreviousZipFile(zipFilename);
    await createZip(zipFilename);

    if (beta) {
        manifest.name = manifest.name.replace(/ \[beta\]$/, "");
        if (manifest.browser_action && manifest.browser_action.default_title) {
            manifest.browser_action.default_title = manifest.browser_action.default_title.replace(/ \[beta\]$/, "");
        }
        if (manifest.action && manifest.action.default_title) {
            manifest.action.default_title = manifest.action.default_title.replace(/ \[beta\]$/, "");
        }
        await saveManifest(manifest);
    }

    logSuccess(`created ${path.join(ZIP_FOLDERNAME, zipFilename)}`);
}

async function getManifest() {
    const manifest = await readFile(FILEPATH_MANIFEST);
    return JSON.parse(manifest);
}

async function saveManifest(manifest) {
    return await writeFile(FILEPATH_MANIFEST, JSON.stringify(manifest, null, 2));
}

function getZipFilename(version = "", beta = false, suffix = "") {
    if (!ZIP_FILENAME_INCLUDE_VERSION) version = "";
    return `${REPOSITORY_NAME}${version ? "-" + version : ""}${beta ? "-beta" : ""}${suffix ? `-${suffix}` : ""}.zip`;
}

async function deletePreviousZipFile(zipFilename) {
    try {
        await deleteFile(zipFilename);
    } catch {}
}

async function createZip(zipFilename) {
    const zip = new AdmZip();
    for (let folder of ZIP_CONTENT.folders) {
        zip.addLocalFolder(folder, folder);
    }
    for (let file of ZIP_CONTENT.files) {
        const filepath = path.dirname(file);
        zip.addLocalFile(file, filepath !== "." ? filepath : undefined);
    }
    try {
        await executeCommand(`mkdir ${ZIP_FOLDERNAME}`);
    } catch {}
    zip.writeZip(path.join(ZIP_FOLDERNAME, zipFilename));
}

async function openAMOAddonUpload(beta = false) {
    const cmd = osPlatform === "linux" ? "firefox" : "start";
    try {
        if (beta && AMO_URL_BETA) {
            await executeCommand(`${cmd} ${AMO_URL_BETA}`);
        } else if (AMO_URL) {
            await executeCommand(`${cmd} ${AMO_URL}`);
        }
    } catch (err) {
        console.error("Error when opening AMO url", err);
    }
}

async function deployAddon() {
    // adds new addon version to updates.json and README.md + removes previous
    const version = (await getManifest()).version;
    const xpiFilepath = await getFilepathOfXPI(version);
    if (!xpiFilepath) {
        logError(`You need to download the .xpi of v${version} before you can run this deploy script`);
        return;
    }
    const xpiFileHash = await getFileHash(xpiFilepath);

    await updateUpdatesJSON(version, xpiFilepath, xpiFileHash);
    await updateReadme(version, xpiFilepath);

    logSuccess(`added ${xpiFilepath} to ${FILEPATH_UPDATES} and ${FILEPATH_README}`);
}

async function getFilepathOfXPI(version) {
    const cmd = osPlatform === "linux" ? "ls" : "dir";
    const directoryContent = await executeCommand(`${cmd} ${DIRECTORY_NAME_XPI}`);
    for (let line of directoryContent.split("\n")) {
        if (line.includes(version) && line.includes(".xpi")) {
            const filename = line.split(" ").pop().trim();
            return `${DIRECTORY_NAME_XPI}/${filename}`;
        }
    }
}

async function getFileHash(filepath) {
    if (osPlatform === "linux") {
        const cmdHashResult = await executeCommand(`sha256sum ${filepath}`);
        const hash = cmdHashResult.split(" ")[0];
        return hash;
    } else {
        const cmdHashResult = await executeCommand(`certUtil -hashFile ${filepath} sha256`);
        const hash = cmdHashResult.split("\n")[1].trim();
        return hash;
    }
}

async function updateUpdatesJSON(version, xpiFilepath, xpiFileHash) {
    let updatesJSON = JSON.parse(await readFile(FILEPATH_UPDATES));
    removePreviousPatchVersions(updatesJSON, version);
    addNewVersion(updatesJSON, version, xpiFilepath, xpiFileHash);
    await writeFile(FILEPATH_UPDATES, stringifyUpdatesJSON(updatesJSON));
}

function removePreviousPatchVersions(updatesJSON, addonVersion) {
    addonVersion = getSemanticVersion(addonVersion);
    updatesJSON.addons[Object.keys(updatesJSON.addons)[0]].updates = updatesJSON.addons[Object.keys(updatesJSON.addons)[0]].updates.filter(
        function (version) {
            const curVersion = getSemanticVersion(version.version);
            if (addonVersion.major === curVersion.major && addonVersion.minor === curVersion.minor) {
                if (addonVersion.patch < curVersion.patch) {
                    logError(`There is already a version ${version.version}`);
                    return true;
                } else if (addonVersion.patch === curVersion.patch) {
                    return false;
                } else {
                    deleteXPI(version.version);
                    return false;
                }
            }
            return true;
        }
    );
}

function getSemanticVersion(versionString) {
    let [major, minor, patch] = versionString.split(".").map(Number);
    return { major, minor, patch };
}

async function deleteXPI(version) {
    const filepath = await getFilepathOfXPI(version);
    logInfo(`delete ${filepath}`);
    await deleteFile(filepath);
}

function addNewVersion(updatesJSON, addonVersion, xpiFilepath, xpiFileHash) {
    updatesJSON.addons[Object.keys(updatesJSON.addons)[0]].updates.push({
        version: addonVersion,
        update_link: `${URL_UPDATES}/${xpiFilepath}`,
        update_hash: `sha256:${xpiFileHash}`,
    });
}

function stringifyUpdatesJSON(updatesJSON) {
    let str = JSON.stringify(updatesJSON, null, 2);
    str = str.replace(/},\n\s+{/g, "}, {"); // removes linebreaks between objects in an array
    return str;
}

async function updateReadme(version, xpiFilepath) {
    let content = await readFile(FILEPATH_README);
    const oldVersion = getOldVersionNumberFromReadme(content);
    let badges = README_BADGE_TEXT.replace(/{URL_UPDATES}/g, URL_UPDATES)
        .replace(/{XPI_FILEPATH}/g, xpiFilepath)
        .replace(/{VERSION}/g, version);
    content =
        content.split(README_BADGE_INSERT_START)[0] +
        README_BADGE_INSERT_START +
        "\n" +
        badges +
        "\n" +
        README_BADGE_INSERT_END +
        content.split(README_BADGE_INSERT_END)[1];
    if (oldVersion) {
        content = content.replace(
            new RegExp(`https://img.shields.io/badge/([a-z]+)-v${oldVersion.replace(/\./g, "\\.")}-`, "g"),
            `https://img.shields.io/badge/$1-v${version}-`
        );
    }
    await writeFile(FILEPATH_README, content);
}

function getOldVersionNumberFromReadme(readmeContent) {
    const regexOldVersion = README_BADGE_TEXT.replace(/\</g, "\\<")
        .replace(/\>/g, "\\>")
        .replace(/\?/g, "\\?")
        .replace(/\./g, "\\.")
        .replace(/{URL_UPDATES}/g, ".*")
        .replace(/{XPI_FILEPATH}/g, ".*")
        .replace(/{VERSION}/g, "(?<version>.*)");
    const oldVersion = readmeContent.match(new RegExp(regexOldVersion))?.groups?.version;
    return oldVersion;
}

async function readFile(filepath) {
    return new Promise(async function (resolve, reject) {
        fs.readFile(filepath, "utf8", function (err, data) {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

async function writeFile(filepath, content) {
    return new Promise(async function (resolve, reject) {
        fs.writeFile(filepath, content, "utf8", function (err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function deleteFile(filepath) {
    return new Promise(async function (resolve, reject) {
        fs.unlink(filepath, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function executeCommand(command) {
    return new Promise(async function (resolve, reject) {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error.message);
            } else if (stderr) {
                reject(stderr);
            } else {
                resolve(stdout);
            }
        });
    });
}

function logError(message) {
    console.log(`${CONSOLE_LOG_COLOR_FG_RED}${message}${CONSOLE_LOG_COLOR_RESET}`);
}
function logInfo(message) {
    console.log(message);
}
function logSuccess(message) {
    console.log(`${CONSOLE_LOG_COLOR_FG_GREEN}${message}${CONSOLE_LOG_COLOR_RESET}`);
}
