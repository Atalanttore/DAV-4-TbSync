/*
 * This file is part of DAV-4-TbSync.
 *
 * TbSync is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TbSync is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with DAV-4-TbSync. If not, see <https://www.gnu.org/licenses/>.
 */

"use strict";

dav.sync = {

    failed: function (msg = "") {
        let e = new Error();
        e.message = msg;
        e.type = "dav4tbsync";
        return e;
    },

    succeeded: function (msg = "") {
        let e = new Error();
        e.message = "OK";
        if (msg) e.message = e.message + "." + msg;
        e.type = "dav4tbsync";
        return e;
    },





    folderList: Task.async (function* (syncdata) {
        //This is a very simple implementation of the discovery method of sabre/dav.
        //I am not even checking if there are changes, I just pull the current list from the server and replace the local list
        //Method description: http://sabre.io/dav/building-a-caldav-client/

        let davjobs = {
            card : {type: 'carddav', hometag: 'addressbook-home-set', typetag: 'addressbook'},
            cal : {type: 'caldav', hometag: 'calendar-home-set', typetag: 'calendar'},
        };

        //get all folders currently known
        let folders = tbSync.db.getFolders(syncdata.account);
        let deletedFolders = [];
        for (let f in folders) {
            deletedFolders.push(f);
        }

        let jobsfound = 0;
        for (let job in davjobs) {
            //sync states are only printed while the account state is "syncing" to inform user about sync process (it is not stored in DB, just in syncdata)
            //example state "getfolders" to get folder information from server
            //if you send a request to a server and thus have to wait for answer, use a "send." syncstate, which will give visual feedback to the user,
            //that we are waiting for an answer with timeout countdown

            let home = null;
            let principal = null;

            tbSync.setSyncState("send.getfolders", syncdata.account);
            {
                //if host is FQDN assume .well-known approach, otherwise direct specification of dav server
                let account = tbSync.db.getAccount(syncdata.account);
                let hostparts = account.host.split("/").filter(i => i != "");
                let fqdn = hostparts.splice(0,1);
                //reduce IO by checking if value changed
                if (fqdn != tbSync.db.getAccountSetting(syncdata.account, "fqdn")) {
                    tbSync.db.setAccountSetting(syncdata.account, "fqdn", fqdn);
                }

                let addr = (hostparts.length == 0) ? "/.well-known/"+davjobs[job].type : "/" + hostparts.join("/");

                let response = yield dav.tools.sendRequest("<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:current-user-principal /></d:prop></d:propfind>", addr , "PROPFIND", syncdata, {"Depth": "0", "Prefer": "return-minimal"});
                if (response && response.error) { //404 or 403
                    continue;
                }
                tbSync.setSyncState("eval.folders", syncdata.account);
                principal = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], ["d","current-user-principal"], ["d","href"]]);
            }
            jobsfound++;

            //principal now contains something like "/remote.php/carddav/principals/john.bieling/"
            // -> get home/root of storage
            if (principal !== null) {
                tbSync.setSyncState("send.getfolders", syncdata.account);
                let response = yield dav.tools.sendRequest("<d:propfind "+dav.tools.xmlns(["d", job])+"><d:prop><"+job+":"+davjobs[job].hometag+" /></d:prop></d:propfind>", principal, "PROPFIND", syncdata, {"Depth": "0", "Prefer": "return-minimal"});

                tbSync.setSyncState("eval.folders", syncdata.account);
                home = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], [job, davjobs[job].hometag], ["d","href"]], principal);
            }

            //home now contains something like /remote.php/caldav/calendars/john.bieling/
            // -> get all calendars and addressbooks
            if (home !== null) {
                tbSync.setSyncState("send.getfolders", syncdata.account);
                let request = (job == "cal")
                                        ? "<d:propfind "+dav.tools.xmlns(["d","apple"])+"><d:prop><d:resourcetype /><d:displayname /><apple:calendar-color/></d:prop></d:propfind>"
                                        : "<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:resourcetype /><d:displayname /></d:prop></d:propfind>";

                let response = yield dav.tools.sendRequest(request, home, "PROPFIND", syncdata, {"Depth": "1", "Prefer": "return-minimal"});

                for (let r=0; r < response.multi.length; r++) {
                    //is this a result with a valid recourcetype? (the node must be present)
                    let resourcetype = dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","resourcetype"], [job, davjobs[job].typetag]]);
                    if (resourcetype === null || response.multi[r].status != "200") continue;

                    let href = response.multi[r].href;
                    let name_node = dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["d","displayname"]]);
                    let name = job == "cal" ? "unnamed calendar" : "unnamed address book";
                    if (name_node != null) {
                        name = name_node.textContent;
                    }
                    let color = dav.tools.evaluateNode(response.multi[r].node, [["d","prop"], ["apple","calendar-color"]]);

                    let folder = tbSync.db.getFolder(syncdata.account, href);
                    if (folder === null || folder.cached === "1") { //this is NOT called by unsubscribing/subscribing
                        let newFolder = {}
                        newFolder.folderID = href;
                        newFolder.name = name;
                        newFolder.type = davjobs[job].type;
                        newFolder.parentID = "0"; //root - tbsync flatens hierachy, using parentID to sort entries
                        newFolder.selected = (r == 1) ? tbSync.db.getAccountSetting(syncdata.account, "syncdefaultfolders") : "0"; //only select the first one

                        //if there is a cached version of this folderID, addFolder will merge all persistent settings - all other settings not defined here will be set to their defaults
                        tbSync.db.addFolder(syncdata.account, newFolder);
                    } else {
                        //Update name & color
                        tbSync.db.setFolderSetting(syncdata.account, href, "name", name);
                        deletedFolders = deletedFolders.filter(item => item !== href);
                    }

                    //update color from server
                    if (color && job == "cal") {
                        color = color.textContent.substring(0,7);
                        tbSync.db.setFolderSetting(syncdata.account, href, "targetColor", color);
                        //do we have to update the calendar?
                        if (cal && folder && folder.target) {
                            let targetCal = cal.getCalendarManager().getCalendarById(folder.target);
                            if (targetCal !== null) {
                                targetCal.setProperty("color", color);
                            }
                        }
                    }
                }

            } else {
                //home was not found - connection error? - do not delete anything
                let deletedFolders = [];
            }
        }

        if (jobsfound == 0) {
            throw dav.sync.failed("service-discovery-failed");
        }

        //remove deleted folders (no longer there)
        for (let i = 0; i < deletedFolders.length; i++) {
            tbSync.takeTargetOffline("dav", folders[deletedFolders[i]], " [deleted on server]");
        }

    }),





    allPendingFolders: Task.async (function* (syncdata) {
        do {
            //any pending folders left?
            let folders = tbSync.db.findFoldersWithSetting("status", "pending", syncdata.account);
            if (folders.length == 0) {
                //all folders of this account have been synced
                throw dav.sync.succeeded();
            }
            //what folder are we syncing?
            syncdata.folderID = folders[0].folderID;
            syncdata.type = folders[0].type;

            try {
                switch ( syncdata.type) {
                    case "carddav":
                        {
                            // check SyncTarget
                            if (!tbSync.checkAddressbook(syncdata.account, syncdata.folderID)) {
                                //could not create target
                                throw dav.sync.failed("notargets");
                            }

                            //get sync target of this addressbook
                            syncdata.targetId = tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "target");
                            syncdata.addressbookObj = tbSync.getAddressBookObject(syncdata.targetId);

                            //promisify addressbook, so it can be used together with yield (using same interface as promisified calender)
                            syncdata.targetObj = tbSync.promisifyAddressbook(syncdata.addressbookObj);

                            yield dav.sync.singleFolder(syncdata);
                        }
                        break;

                    case "caldav":
                        {
                            // skip if lightning is not installed
                            if (tbSync.lightningIsAvailable() == false) {
                                throw dav.sync.failed("nolightning");
                            }

                            // check SyncTarget
                            if (!tbSync.checkCalender(syncdata.account, syncdata.folderID)) {
                                //could not create target
                                throw dav.sync.failed("notargets");
                            }

                            //init sync via lightning
                            let target = tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "target");
                            let calManager = cal.getCalendarManager();
                            let targetCal = calManager.getCalendarById(target);
                            targetCal.refresh();
                            tbSync.db.clearChangeLog(target);
                            throw dav.sync.succeeded();
                        }
                        break;

                    default:
                        {
                            throw dav.sync.failed("notsupported");
                        }
                        break;

                }
            } catch (e) {
                if (e.type == "dav4tbsync") tbSync.finishFolderSync(syncdata, e.message);
                else {
                    //abort sync of other folders on javascript error
                    tbSync.finishFolderSync(syncdata, "javascriptError::" + (e.message ? e.message : e));
                    throw e;
                }
            }
        } while (true);
    }),





    singleFolder: Task.async (function* (syncdata)  {
        syncdata.downloadonly = (tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "downloadonly") == "1");
        syncdata.folderCreatedWithProviderVersion = tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "createdWithProviderVersion");

        yield dav.sync.remoteChanges(syncdata);
        let numOfLocalChanges = yield dav.sync.localChanges(syncdata);

        //revert all local changes on permission error by doing a clean sync
        if (numOfLocalChanges < 0) {
            dav.onResetTarget(syncdata.account, syncdata.folderID);
            yield dav.sync.remoteChanges(syncdata);

            if (!syncdata.downloadonly) throw dav.sync.failed("info.restored");
        } else if (numOfLocalChanges > 0){
            //we will get back our own changes and can store etags and vcards and also get a clean ctag/token
            yield dav.sync.remoteChanges(syncdata);
        }

        //always finish sync by throwing failed or succeeded
        throw dav.sync.succeeded();
    }),










    remoteChanges: Task.async (function* (syncdata) {
        //Do we have a sync token? No? -> Initial Sync (or WebDAV sync not supported) / Yes? -> Get updates only (token only present if WebDAV sync is suported)
        let token = tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "token");
        if (token) {
            //update via token sync
            let tokenSyncSucceeded = yield dav.sync.remoteChangesByTOKEN(syncdata);
            if (tokenSyncSucceeded) return;

            //token sync failed, reset ctag and token and do a full sync
            dav.onResetTarget(syncdata.account, syncdata.folderID);
        }

        //Either token sync did not work or there is no token (initial sync)
        //loop until ctag is the same before and after polling data (sane start condition)
        let maxloops = 20;
        for (let i=0; i <= maxloops; i++) {
                if (i == maxloops)
                    throw dav.sync.failed("could-not-get-stable-ctag");

                let ctagChanged = yield dav.sync.remoteChangesByCTAG(syncdata);
                if (!ctagChanged) break;
        }
    }),

    remoteChangesByTOKEN: Task.async (function* (syncdata) {
        let token = tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "token");
        tbSync.setSyncState("send.request.remotechanges", syncdata.account, syncdata.folderID);
        let cards = yield dav.tools.sendRequest("<d:sync-collection "+dav.tools.xmlns(["d","card"])+"><d:sync-token>"+token+"</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><card:address-data /></d:prop></d:sync-collection>", syncdata.folderID, "REPORT", syncdata, {"Content-Type": "application/xml; charset=utf-8"});

        if (cards.error) { //Sabre\DAV\Exception\InvalidSyncToken
            //token sync failed, reset ctag and do a full sync
            return false;
        }

        let tokenNode = dav.tools.evaluateNode(cards.node, [["d", "sync-token"]]);
        if (tokenNode === null) {
            //token sync failed, reset ctag and do a full sync
            return false;
        }

        syncdata.todo = cards.multi.length;
        syncdata.done = 0;
        let abManager = Components.classes["@mozilla.org/abmanager;1"].getService(Components.interfaces.nsIAbManager);
        let addressBook = abManager.getDirectory(syncdata.targetId);
        let vCardsDeletedOnServer = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
        let maxitems = 50;

        for (let ca=0; ca < cards.multi.length; ca+=maxitems) {
            tbSync.setSyncState("eval.response.remotechanges", syncdata.account, syncdata.folderID);
            yield tbSync.sleep(100);
            for (let c=ca; c < cards.multi.length && c < ca + maxitems; c++) {
                let id = cards.multi[c].href;
                if (id !==null) {
                    //valid
                    let status = cards.multi[c].status;
                    let card = addressBook.getCardFromProperty("TBSYNCID", id, true);
                    if (status == "200") {
                        //MOD or ADD
                        let etag = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getetag"]]);
                        let data = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["card","address-data"]]);
                        if (!card) {
                            //ADD
                            dav.tools.addContact (addressBook, id, data, etag, syncdata);
                        } else {
                            //MOD
                            dav.tools.modifyContact (addressBook, id, data, etag, syncdata);
                        }
                    } else if (status == "404" && card) {
                        //DEL
                        vCardsDeletedOnServer.appendElement(card, "");
                        tbSync.db.addItemToChangeLog(syncdata.targetId, id, "deleted_by_server");
                    }
                }
                syncdata.done++;
            }
        }

        //delete all contacts added to vCardsDeletedOnServer
        dav.tools.deleteContacts (addressBook, vCardsDeletedOnServer, syncdata);

        //update token
        tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "token", tokenNode.textContent);

        return true;
    }),

    remoteChangesByCTAG: Task.async (function* (syncdata) {
        //Request ctag and token
        tbSync.setSyncState("send.request.remotechanges", syncdata.account, syncdata.folderID);
        let response = yield dav.tools.sendRequest("<d:propfind "+dav.tools.xmlns(["d", "cs"])+"><d:prop><cs:getctag /><d:sync-token /></d:prop></d:propfind>", syncdata.folderID, "PROPFIND", syncdata, {"Depth": "0"});

        syncdata.todo = 0;
        syncdata.done = 0;
        tbSync.setSyncState("eval.response.remotechanges", syncdata.account, syncdata.folderID);
        let ctag = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], ["cs", "getctag"]], syncdata.folderID);
        let token = dav.tools.getNodeTextContentFromMultiResponse(response, [["d","prop"], ["d", "sync-token"]], syncdata.folderID);

        //if CTAG changed, we need to sync everything and compare
        if (ctag === null || ctag != tbSync.db.getFolderSetting(syncdata.account, syncdata.folderID, "ctag")) {
            let vCardsFoundOnServer = [];
            let vCardsChangedOnServer = {};

            let abManager = Components.classes["@mozilla.org/abmanager;1"].getService(Components.interfaces.nsIAbManager);
            let addressBook = abManager.getDirectory(syncdata.targetId);

            //get etags of all cards on server and find the changed cards
            tbSync.setSyncState("send.request.remotechanges", syncdata.account, syncdata.folderID);
            let cards = yield dav.tools.sendRequest("<d:propfind "+dav.tools.xmlns(["d"])+"><d:prop><d:getetag /><d:getcontenttype /></d:prop></d:propfind>", syncdata.folderID, "PROPFIND", syncdata, {"Depth": "1", "Prefer": "return-minimal"});

            //does not work on older servers
            //let cards = yield dav.tools.sendRequest("<card:addressbook-query "+dav.tools.xmlns(["d", "card"])+"><d:prop><d:getetag /></d:prop></card:addressbook-query>", syncdata.folderID, "REPORT", syncdata, {"Depth": "1", "Prefer": "return-minimal"});
            tbSync.setSyncState("eval.response.remotechanges", syncdata.account, syncdata.folderID);
            for (let c=0; cards.multi && c < cards.multi.length; c++) {
                let id =  cards.multi[c].href;
                let etag = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getetag"]]);
                let ctype = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getcontenttype"]]);
                if (cards.multi[c].status == "200" && etag !== null && id !== null && ctype !== null) { //we do not actualyl check the content of ctype
                    vCardsFoundOnServer.push(id);
                    let card = addressBook.getCardFromProperty("TBSYNCID", id, true);
                    if (!card) {
                        //if the user deleted this card (not yet send to server), do not add it again
                        if (tbSync.db.getItemStatusFromChangeLog(syncdata.targetId, id) != "deleted_by_user")  vCardsChangedOnServer[id] = "ADD";
                    } else if (etag.textContent != card.getProperty("X-DAV-ETAG","")) vCardsChangedOnServer[id] = "MOD";
                }
            }

            //download all changed cards and process changes
            let cards2catch = Object.keys(vCardsChangedOnServer);
            syncdata.todo = cards2catch.length;
            syncdata.done = 0;
            let maxitems = 50;

            for (let i=0; i < cards2catch.length; i+=maxitems) {
                let request = dav.tools.getMultiGetRequest(cards2catch.slice(i, i+maxitems));
                if (request) {
                    tbSync.setSyncState("send.request.remotechanges", syncdata.account, syncdata.folderID);
                    let cards = yield dav.tools.sendRequest(request, syncdata.folderID, "REPORT", syncdata, {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"});

                    syncdata.done = i;
                    tbSync.setSyncState("eval.response.remotechanges", syncdata.account, syncdata.folderID);
                    for (let c=0; c < cards.multi.length; c++) {
                        let id =  cards.multi[c].href;
                        let etag = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["d","getetag"]]);
                        let data = dav.tools.evaluateNode(cards.multi[c].node, [["d","prop"], ["card","address-data"]]);

                        if (cards.multi[c].status == "200" && etag !== null && data !== null && id !== null && vCardsChangedOnServer.hasOwnProperty(id)) {
                            switch (vCardsChangedOnServer[id]) {
                                case "ADD":
                                    dav.tools.addContact (addressBook, id, data, etag, syncdata);
                                    break;

                                case "MOD":
                                    dav.tools.modifyContact (addressBook, id, data, etag, syncdata);
                                    break;
                            }
                        }
                    }
                }
            }

            //FIND DELETES: loop over current addressbook and check each local card if it still exists on the server
            let vCardsDeletedOnServer = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
            cards = addressBook.childCards;
            while (true) {
                let more = false;
                try { more = cards.hasMoreElements() } catch (ex) {}
                if (!more) break;

                let card = cards.getNext().QueryInterface(Components.interfaces.nsIAbCard);
                let id = card.getProperty("TBSYNCID","");
                if (id && !vCardsFoundOnServer.includes(id) && tbSync.db.getItemStatusFromChangeLog(syncdata.targetId, id) != "added_by_user") {
                    //delete request from server
                    vCardsDeletedOnServer.appendElement(card, "");
                    tbSync.db.addItemToChangeLog(syncdata.targetId, id, "deleted_by_server");
                }
            }
            dav.tools.deleteContacts (addressBook, vCardsDeletedOnServer, syncdata);


            //update ctag and token (if there is one)
            if (ctag === null) return false; //if server does not support ctag, "it did not change"
            tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "ctag", ctag);
            if (token) tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "token", token);

            //ctag did change
            return true;
        } else {

            //ctag did not change
            return false;
        }

    }),





    localChanges: Task.async (function* (syncdata) {
        //define how many entries can be send in one request
        let maxnumbertosend = 50;

        //access changelog to get local modifications (done and todo are used for UI to display progress)
        syncdata.done = 0;
        syncdata.todo = db.getItemsFromChangeLog(syncdata.targetId, 0, "_by_user").length;

        let abManager = Components.classes["@mozilla.org/abmanager;1"].getService(Components.interfaces.nsIAbManager);
        let addressBook = abManager.getDirectory(syncdata.targetId);
        let permissionError = syncdata.downloadonly; //start with "permissionError", if the user has set this to downloadonly

        do {
            tbSync.setSyncState("prepare.request.localchanges", syncdata.account, syncdata.folderID);

            //get changed items from ChangeLog
            let changes = db.getItemsFromChangeLog(syncdata.targetId, maxnumbertosend, "_by_user");
            if (changes == 0)
                break;

            for (let i=0; i<changes.length; i++) {
                switch (changes[i].status) {
                    case "added_by_user":
                    case "modified_by_user":
                        {
                            if (!permissionError) { //no need to do any other requests, if there was a permission error already
                                let isAdding = (changes[i].status == "added_by_user");
                                let vcard = dav.tools.getVCardFromThunderbirdCard (syncdata, addressBook, changes[i].id, isAdding);
                                let options = {"Content-Type": "text/vcard; charset=utf-8"};
                                //if (!isAdding) options["If-Match"] = vcard.etag;

                                tbSync.setSyncState("send.request.localchanges", syncdata.account, syncdata.folderID);
                                let response = yield dav.tools.sendRequest(vcard.data, changes[i].id, "PUT", syncdata, options);

                                tbSync.setSyncState("eval.response.localchanges", syncdata.account, syncdata.folderID);
                                if (response && response.error) { //Sabre\DAVACL\Exception\NeedPrivileges
                                    permissionError = true;
                                }
                            }

                            if (permissionError) {
                                dav.tools.invalidateThunderbirdCard(syncdata, addressBook, changes[i].id);
                            }
                        }
                        break;

                    case "deleted_by_user":
                        {
                            if (!permissionError) { //no need to do any other requests, if there was a permission error already
                                tbSync.setSyncState("send.request.localchanges", syncdata.account, syncdata.folderID);
                                let response = yield dav.tools.sendRequest("", changes[i].id , "DELETE", syncdata, {});

                                tbSync.setSyncState("eval.response.localchanges", syncdata.account, syncdata.folderID);
                                if (response && response.error) { //Sabre\DAVACL\Exception\NeedPrivileges
                                    permissionError = true;
                                }
                            }

                            if (permissionError) {
                                tbSync.db.addItemToChangeLog(syncdata.targetId, changes[i].id, "deleted_by_server");
                            }
                        }
                        break;
                }

                db.removeItemFromChangeLog(syncdata.targetId, changes[i].id);
                syncdata.done++; //UI feedback
            }


        } while (true);

        //return number of modified cards or -1 on permission error
        return (permissionError ? -1 : syncdata.done);
    }),


}
