/*
 * XD-MVC -- A framework for cross-device applications
 * Copyright (C) 2014-2015 Maria Husmann. All rights reserved.
 *
 * XD-MVC is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * XD-MVC is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with XD-MVC. If not, see <http://www.gnu.org/licenses/>.
 *
 * See the README and LICENSE files for further information.
 *
 */

var util         = require("util");
var EventEmitter = require("events").EventEmitter;
var PeerServer = require('peer').PeerServer;
var shortid = require('shortid');
var connect = require('connect'),
    http = require('http'),
    bodyParser = require('body-parser'),
    url = require('url');

//for socketIo
var io =  require('socket.io')();

//CORS middleware
var allowCrossDomain = function(req, res, next) {
    res.setHeader ('Access-Control-Allow-Origin', "*");
    res.setHeader ('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
    res.setHeader ('Access-Control-Allow-Headers', 'Content-Type');
    next();
};

function XDmvcServer() {
    EventEmitter.call(this);
    this.socketIoPeers = {};
    this.peerJsPeers = {};
    this.peers = {}; //union of socketIoPeers and peerJsPeers
    this.sessions = {};
    this.configuredRoles = {};
    this.idBase = 0;
    this.dict = {}; //key = Google UserId Token "sub", value = deviceId
    this.userDevices = {}; //key =  User's Google id, value = List of deviceIDs
    this.userIds = {}; //key = deviceId , value = User's Google id
    this.deviceLocations = {} ; //key = deviceID, value:  location coordinate lat,long,google userid
    this.distances = {}; //{userID: { contactID : {deviceID: distance in km} }
    this.relationships = {}; //{User's Google id: { User's friend's Google id : relationship} }
    this.friendsByGroup = {};  //{user's google id: {relationship : {friend's id : true}}}
    this.pairingRequests = {}; //{ deviceID :{Google user id of user who wants to pair with this device : ""}

}
util.inherits(XDmvcServer, EventEmitter);


XDmvcServer.prototype.addPeer = function addPeer(id) {
    console.log("Adding peer " + id);
    this.peers[id] = {
        'id': id,
        'name': undefined,
        'role': undefined,
        'roles': [],
        'session': undefined,
        'usesPeerJs': false,
        'usesSocketIo': false
    };
};
XDmvcServer.prototype.addPeerJsPeer = function addPeerJsPeer(id, peerId) {
    this.peers[id].usesPeerJs = true;
    this.peers[id].peerId = peerId;

    this.peerJsPeers[id] = {
        'id': id,
        'peerId': peerId,
        'name': undefined,
        'role': undefined,
        'roles': [],
        'session': undefined
    };
};

XDmvcServer.prototype.addSocketIoPeer = function addSocketIoPeer(id, socketioId) {
    console.log("adding socketio peer " + id + " " + socketioId);
    this.peers[id].usesSocketIo = true;
    // this.peers[id].peerId = id
    this.socketIoPeers[id] = {
        'id': id,
        'socketioId': socketioId,
        'name': undefined,
        'role': undefined,
        'roles': [],
        'session': undefined,
        'connectedPeers' : [],
        'users' : []
    };
};

XDmvcServer.prototype.deletePeerJsPeer = function deletePeerJsPeer(id) {
    if (this.peerJsPeers[id]) {
        delete this.peerJsPeers[id];
    }
    if(this.peers[id])
        if(this.peers[id].usesSocketIo) //peer is still used with socketio
            this.peers[id].usesPeerJs = false;
        else //peer is not used anymore
            delete this.peers[id];
};

XDmvcServer.prototype.deleteSocketIoPeer = function deleteSocketIoPeer(id) {
    delete this.socketIoPeers[id];
    if(this.peers[id]) {
        /* As PeerJS does not always properly disconnect, assume that
         * the PeerJS connection will also be dead and remove the peer.
         * If this PeerJS is fixed, this could be adapted to the old version below
         */
        if(this.peers[id].usesPeerJs) {
            delete this.peerJsPeers[id];
        }
        delete this.peers[id];
    }

    /* old version
     delete this.socketIoPeers[id];
     if(this.peers[id])
     if(this.peers[id].usesPeerJs)//peer is still used with peerJS
     this.peers[id].usesSocketIo = false;
     else
     delete this.peers[id];

     */
};

XDmvcServer.prototype.startPeerSever = function(port){

    //Start the PeerJS Server
    var pserver = new PeerServer({
        port: port,
        allow_discovery: true
    });
    var that = this;

    /*
     pserver.on('connection', function(id) {
     console.log("user connected via PeerJS. ID: " + id);
     that.addPeerJsPeer(id);
     that.emit("connected", id);
     });
     */
    pserver.on('disconnect', function(id) {
        var deviceId = Object.keys(that.peerJsPeers).filter(function(key){
            return that.peerJsPeers[key].peerId == id;
        })[0];
        if (deviceId && (that.peerJsPeers[deviceId].session !== undefined)) {
            var ps = that.sessions[that.peerJsPeers[deviceId].session].peers;
            var index = ps.indexOf(deviceId);
            if (index > -1) {
                ps.splice(index, 1);
            }

            if (ps.length === 0) {
                // session has no more users -> delete it
                delete that.sessions[that.peerJsPeers[deviceId].session];
            }
        }
        that.deletePeerJsPeer(deviceId);

        that.emit("disconnected", deviceId);
    });

};

XDmvcServer.prototype.startSocketIoServer = function startSocketIoServer(port) {

    //Start the Socketio Server
    io.listen(port);

    var xdServer = this;

    io.on('connection', function(socket){
        var id = socket.id;

        console.log('user connected ' + socket.id);
        xdServer.emit("connected", id);

        socket.on('id', function(msg){
            console.log('match deviceId ' + msg  + ' to socketioId ' + id);
            xdServer.addSocketIoPeer(msg, this.id);
        });

        socket.on('disconnect', function(){
            //TODO: handle disconnect
            //console.log('user disconnected ' + socket.id);
            var deviceId;
            var connPeers;

            //There should be exactly one object in socketIoPeers with socketioId === socket.id
            for(var peer in xdServer.socketIoPeers)
                if (xdServer.socketIoPeers[peer] && xdServer.socketIoPeers[peer].socketioId === socket.id){
                    deviceId = peer;
                    connPeers =xdServer.socketIoPeers[deviceId].connectedPeers;
                }

            xdServer.deleteSocketIoPeer(deviceId); //delete peer that disconnected

            if(deviceId) {
                var arrayLength = connPeers.length;
                var msg = {sender:deviceId, eventTag:'close'};
                for (var i = 0; i < arrayLength; i++) {
                    var peerObject= xdServer.socketIoPeers[connPeers[i]];
                    if(peerObject){// otherwise the other one disconnected nearly simultaneously or was connected to himself
                        io.sockets.connected[peerObject.socketioId].emit('wrapMsg', msg); //send message only to interestedDevice
                        var removeDeviceId = peerObject.connectedPeers.filter(
                            function(thisDevice){ return thisDevice !== deviceId;}
                        ); // splice the array at index of deviceId
                        peerObject.connectedPeers = removeDeviceId;
                    }
                }
                console.log('user '+ deviceId + ' disconnected --> server sent close event to connected socketIoPeers: ' + connPeers);
            } else
                console.log('peer was not in socketIoPeers --> TODO:check logic');
        });

        socket.on('connectTo', function(msg) {
            var receiver = msg.receiver;
            if(xdServer.socketIoPeers[receiver] !== undefined) {
                var socketId = xdServer.socketIoPeers[receiver].socketioId;
                console.log(msg.sender + ' tries to connect to ' + receiver);
                io.sockets.connected[socketId].emit('connectTo', msg);
            } else {
                var err = {
                    eventTag : 'error',
                    sender : msg.receiver,
                    type : "peer-unavailable",
                    message : "the peer you wanted to connect to is not available"
                };
                io.sockets.connected[this.id].emit('wrapMsg', err);
                console.log(msg.sender + ' tries to connect to ' + msg.receiver + ' : failed ! (peer not available)');
            }
        });

        socket.on('readyForOpen', function(msg) {
            // store the id's in socketIoPeers.connectedPeers
            xdServer.socketIoPeers[msg.recA].connectedPeers.push(msg.recB);
            xdServer.socketIoPeers[msg.recB].connectedPeers.push(msg.recA);

            //one of both is identical to this.id
            var socketidA = xdServer.socketIoPeers[msg.recA].socketioId;
            var socketidB = xdServer.socketIoPeers[msg.recB].socketioId;
            // send open Event to both socketIoPeers
            var msgA = {sender:msg.recB, eventTag:'open'};
            var msgB = {sender:msg.recA, eventTag:'open'};
            //TODO:maybe check if really connected
            io.sockets.connected[socketidA].emit('wrapMsg', msgA);
            io.sockets.connected[socketidB].emit('wrapMsg', msgB);

            console.log('--> connection established !');
        });

        socket.on('wrapMsg', function(msg){
            //console.log('message: ' + msg + ' for ' + msg.receiver);
            var connRec = xdServer.socketIoPeers[msg.receiver];
            if(connRec !== undefined)
                io.sockets.connected[connRec.socketioId].emit('wrapMsg', msg); //send message only to interestedDevice
            else {
                var err = {
                    eventTag : 'error',
                    sender : msg.receiver,
                    type : "peer-unavailable",
                    message : "the peer you wanted to connect to is not available"
                };
                //Could also send close...
                io.sockets.connected[this.id].emit('wrapMsg', err);
                console.log(msg.sender + ' tried to send a message to ' + msg.receiver + ' which is not connected -> error');
            }
        });

        socket.on('error', function(err){
            console.log('socket Error: ' + err);
        });

    });
};



XDmvcServer.prototype.startAjaxServer = function(port){
    /*
     var that = this;

     var ajax = function(req, res, next){
     return that.handleAjaxRequest(req,res,next);
     };
     */
    var app = connect().use(bodyParser.json({limit: '50mb'})).use(allowCrossDomain).use(this.handleAjaxRequest.bind(this));
    var server = http.createServer(app);
    server.listen(port);
};

XDmvcServer.prototype.handleAjaxRequest = function(req, res, next){
    var parameters = url.parse(req.url, true);
    var query = parameters.query;

    res.statusCode = 200;

    if (req.method == "POST") {
        query = req.body;
    } else if (req.method == "OPTIONS"){
        res.end();
        return;
    }
    res.setHeader("Content-Type", "text/json");

    switch (query.type){
        case 'logLocation':
            var arr = query.data;
            this.deviceLocations[query.id]= [arr[1],arr[2],arr[0]];
            console.log("Location has been logged for "+query.id+ ", "+arr[0]);
            res.end();
            break;
        case 'logDistance':
            console.log("logging distance");
            var myLocationEntry= this.deviceLocations[query.id];
            var userID = this.userIds[query.id];
            var contactID = query.data;
            var devices = Object.keys(this.userDevices[contactID]);
            console.log(devices);
            for(var k = 0 ; k< devices.length; k++){
                var deviceID = devices[k];
                var contactsLocationEntry = this.deviceLocations[deviceID];
                console.log("iterating devices");
                if(contactsLocationEntry && contactsLocationEntry.length>0 && myLocationEntry && myLocationEntry.length>0) {
                    console.log("found location entries");
                    var lat1 = myLocationEntry[0];
                    var lon1 = myLocationEntry[1];
                    var lat2 = contactsLocationEntry[0];
                    var lon2 = contactsLocationEntry[1];
                    console.log(lat2 + " * " + lon2);
                    var R = 6371; // Radius of the earth in km
                    var dLat = (lat2 - lat1) * (Math.PI / 180);  // deg2rad below
                    var dLon = (lon2 - lon1) * (Math.PI / 180);
                    var a =
                            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos((lat1) * (Math.PI / 180)) *
                            Math.cos((lat2) * (Math.PI / 180)) *
                            Math.sin(dLon / 2) * Math.sin(dLon / 2)
                        ;
                    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                    var d = R * c; // Distance in km
                    console.log("DISTANCE " + d);
                    if(!this.distances[userID]) this.distances[userID] = {};
                    if(!this.distances[userID][contactID]) this.distances[userID][contactID] = {};
                    this.distances[userID][contactID][deviceID] = d;

                    res.write(JSON.stringify(d));
                    console.log("DISTANCES: "+ this.distances);
                }
            }
            res.end();
            break;
        case 'listAllPeers':
            // return list of all peers
            var peersArray = Object.keys(this.peers).map(function (key) {return this.peers[key]}, this);
            res.write('{"peers": ' + JSON.stringify(peersArray) + ', "sessions": ' + JSON.stringify(this.sessions) + '}');
            res.end();
            break;
        case 'removeDevice':
            //TODO: on disconnect, clean dicts.
            console.log("REFRESHING OR CLOSING");
            if(this.userIds[query.id]){
                var userID = this.userIds[query.id];
                if(this.userDevices[userID][query.id]){
                    delete this.userDevices[userID][query.id];
                }
                else{
                    console.log('removeDevice error: no device found ')
                }
                if(Object.keys(this.userDevices[userID]).length <= 0){
                    //no more logged in devices for this user
                    delete this.userDevices[userID];
                }
            }
            else{
                console.log('removeDevice error: no user id for this device')
            }
            if(this.deviceLocations[query.id]){
                delete this.deviceLocations[query.id];
            }
            res.end();
            break;
        case 'sortGroupByDistance':
            var contactList = Object.keys(JSON.parse(query.data));
            var userID = this.userIds[query.id];
            var groupDistances = {};
            for(var c = 0; c < contactList.length;c++){
                var contactID = contactList[c]
                var devices = this.distances[userID][contactID];
                console.log("DEVICES "+JSON.stringify(devices));
                for( var j in devices){
                    if(this.deviceLocations[j]) {
                        groupDistances[j] = devices[j];
                    }
                    else{
                        delete devices[j];
                        //TODO: needs to get  new distance to new device
                    }
                }
                //Object.append(this.distances[userID][contactID],groupDistances);
            }
            var sortable = [];
            for (var device in groupDistances){
                sortable.push([device, this.userIds[device], groupDistances[device] ])
            }
            sortable.sort(function(a,b){ return a[2]-b[2]});
            res.write(JSON.stringify(sortable));

            res.end();
            break;
        case 'getFriendsByGroup':
            if(this.userIds[query.id]){
                var userID = this.userIds[query.id];
                if(this.friendsByGroup[userID]){
                    if(query.data == "all"){
                        if(this.relationships[userID]){
                            var contacts = Object.keys(this.relationships[userID]);
                            for(var i = 0; i < contacts.length; i ++){
                                //check if contacts online;
                                var contactID = contacts[i];
                                if(!this.userDevices[contactID]){
                                    //delete offline contacts
                                    delete this.relationships[userID][contactID];
                                }
                            }
                            res.write(JSON.stringify(this.relationships[userID]));
                            res.end();
                            break;
                        }
                        else{
                            console.log("in all: ");
                            console.log(this.relationships);
                        }
                    }
                    else{
                        if(this.friendsByGroup[userID][query.data]){
                            var contacts = Object.keys(this.friendsByGroup[userID][query.data]);
                            for(var i = 0; i< contacts.length; i++){
                                var contactID = contacts[i];
                                if(!this.userDevices[contactID]){
                                    //delete offline contacts
                                    delete this.friendsByGroup[userID][query.data][contactID];
                                }
                            }
                            res.write(JSON.stringify(this.friendsByGroup[userID][query.data]));
                        }
                        else{
                            console.log("getFriendsByGroup error : user has no friends in this group")
                            console.log(userID + " " + query.data );
                            console.log(this.friendsByGroup);
                        }
                    }
                }
                else{
                    console.log("getFriendsByGroup error: friends not entered")
                    console.log(userID + " " + query.data );
                    console.log(this.friendsByGroup);
                }

            }
            res.end();
            break;


        case 'checkPairingRequest':
            if(this.pairingRequests[query.id]){
                res.write(JSON.stringify(this.pairingRequests[query.id]));
                console.log("found pairing requests");
            }
            else{
                console.log("no pairing requests");
            }
            res.end();
            break;
        case 'declinePairingRequest':
            if(this.pairingRequests[query.id] && this.pairingRequests[query.id][query.data]){
                delete this.pairingRequests[query.id][query.data];
                res.write("deleted");
            }
            res.end();
            break;
        case 'pairfriends':
            //TODO: should connect to specific device of friend, not just to "last" device of contact
            //TODO: requires that this.relationship is updated for userID and contactID!
            var userID = this.userIds[query.id];
            var contactID = query.data;
            console.log(contactID );
            console.log("CONTACT ID");
            if(this.userDevices[query.data]){
                var contactsDevices = Object.keys(this.userDevices[query.data]);
                var deviceToConnect = contactsDevices[contactsDevices.length-1]; //TODO: should be given as argument by client
                if(this.relationships[userID] && this.relationships[contactID]){//TODO: what if relationships not set yet.
                    if(this.relationships[userID][contactID] == "friend" && this.relationships[contactID][userID] == "friend") {
                        //symmetric friendship,  returns "last" device of contact
                        res.write(deviceToConnect); //connects to last device of contact
                    }
                    else{
                        //asymmetric friendship, not "friend" for both.
                        if(this.pairingRequests[query.id]){
                            console.log(this.pairingRequests[query.id][contactID])
                        }
                        if(this.pairingRequests[query.id] && this.pairingRequests[query.id][contactID]){
                            //pairingRequest accepted
                            delete this.pairingRequests[query.id][contactID];
                            res.write(deviceToConnect);
                        }
                        else {
                            //needs confirmation to pair, add pairingRequest
                            if (this.pairingRequests[deviceToConnect]) {
                                this.pairingRequests[deviceToConnect][userID] = true;
                            }
                            else {
                                this.pairingRequests[deviceToConnect] = {};
                                this.pairingRequests[deviceToConnect][userID] = true
                            }
                            //TODO: notify user, that pairing request was sent
                            console.log("not close friend, pairing request added");
                        }
                    }
                }
                else{
                    //TODO: solve this issue, requires relationships to be set.
                    console.log("Relationships not defined");
                }

            }
            else{
                console.log("NO device found");
            }
            res.end();
            break;
        case 'isContactOnline':
            if(this.userDevices[query.data]){
                res.write(JSON.stringify(this.userDevices[query.data]));
                res.end();
                break;
            }
            res.end();
            break;

        case 'enterRelationship':
            console.log("enterRelationship");
            if(query.data){
                var userID = this.userIds[query.id];
                var contactID = query.data[0];
                var relationshipName = query.data[1];
                if(this.relationships[userID]){
                    this.relationships[userID][contactID] = relationshipName;
                }
                else{
                    this.relationships[userID] = {};
                    this.relationships[userID][contactID] = relationshipName;
                }

                if(!this.friendsByGroup[userID]){
                    this.friendsByGroup[userID] = {};
                }
                if(!this.friendsByGroup[userID][relationshipName]){
                    this.friendsByGroup[userID][relationshipName] = {};
                }
                this.friendsByGroup[userID][relationshipName][contactID] = " ";
            }
            res.end();
            break;
        case 'sync':
            this.emit("objectChanged", query.data);
            res.end();
            break;
        case 'roles':
            // only store role information, if the peer is already connected
            if (this.peers[query.id]){
                this.peers[query.id].roles = query.data;
            }
            res.end();
            break;
        case 'device':
            // only store device information, if the peer is already connected
            if (this.peers[query.id]){
                this.peers[query.id].device = query.data
            }
            res.end();
            break;
        case 'deviceId':
            this.addPeerJsPeer(query.id, query.data.peerId);
            res.end();
            break;
        case 'id':
            var id = query.id;
            var error = false;
            if (!id) {
                id = shortid.generate();
            } else if (!this.idIsFree(id)){
                error = true;
            }
            if (!error) {
                this.emit("connected", id);
                this.addPeer(id);
            }
            res.write(JSON.stringify({id: id, error: error}));
            res.end();
            break;
        case 'userSignOut':
            var split_list = query.data.split('.')
            var jose_header = split_list[0];
            var payload = split_list[1];
            var signature = split_list[2];

            var atob = require('atob');
            var payloadParsed = JSON.parse(atob(payload).toString());
            var userID = payloadParsed.sub;


            //  delete this.peers[query.id].users ;
            delete this.dict[userID];
            delete this.deviceLocations[query.id];
            if(this.userDevices[userID]){
                delete this.userDevices[userID][query.id];
            }
            delete this.userIds[query.id];
            if(Object.keys(this.userDevices[userID]).length > 0){
                //not last device for this user
            }
            else{
                //no more logged in devices for this user
                delete this.userDevices[userID];
            }
            console.log(this.userDevices);

            res.end();
            break;

        case 'userSignIn':
            //var Base64={_keyStr:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",encode:function(e){var t="";var n,r,i,s,o,u,a;var f=0;e=Base64._utf8_encode(e);while(f<e.length){n=e.charCodeAt(f++);r=e.charCodeAt(f++);i=e.charCodeAt(f++);s=n>>2;o=(n&3)<<4|r>>4;u=(r&15)<<2|i>>6;a=i&63;if(isNaN(r)){u=a=64}else if(isNaN(i)){a=64}t=t+this._keyStr.charAt(s)+this._keyStr.charAt(o)+this._keyStr.charAt(u)+this._keyStr.charAt(a)}return t},decode:function(e){var t="";var n,r,i;var s,o,u,a;var f=0;e=e.replace(/[^A-Za-z0-9\+\/\=]/g,"");while(f<e.length){s=this._keyStr.indexOf(e.charAt(f++));o=this._keyStr.indexOf(e.charAt(f++));u=this._keyStr.indexOf(e.charAt(f++));a=this._keyStr.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}t=Base64._utf8_decode(t);return t},_utf8_encode:function(e){e=e.replace(/\r\n/g,"\n");var t="";for(var n=0;n<e.length;n++){var r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r)}else if(r>127&&r<2048){t+=String.fromCharCode(r>>6|192);t+=String.fromCharCode(r&63|128)}else{t+=String.fromCharCode(r>>12|224);t+=String.fromCharCode(r>>6&63|128);t+=String.fromCharCode(r&63|128)}}return t},_utf8_decode:function(e){var t="";var n=0;var r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}}
            if(this.peers[query.id]){
                console.log("signing In");
                var split_list = query.data.split('.');
                var jose_header = split_list[0];
                var payload = split_list[1];
                var signature = split_list[2];
                var atob = require('atob');
                var payloadParsed = JSON.parse(atob(payload).toString());
                var userID = payloadParsed.sub;
                this.peers[query.id].users = userID;
                this.dict[userID] = query.id;
                this.userIds[query.id] = userID;

                if(this.userDevices[userID]){
                    res.write(JSON.stringify(this.userDevices[userID]));
                    this.userDevices[userID][query.id] = " ";
                    console.log("not first login")
                }
                else{
                    this.userDevices[userID] = {};
                    this.userDevices[userID][query.id] = " ";
                    console.log("first login")
                }
                console.log(this.userDevices);

            }
            else{
                console.log("no entry in this.peers")
                console.log(this.peers);
            }
            res.end();
            break;

        default :
            // someone tried to call a not supported method
            // answer with 404
            console.log("not found");
            res.setHeader("Content-Type", "text/html");
            //      res.statusCode = 404;
            res.write('<h1>404 - File not found! </h1>');
            res.write(parameters.pathname);
            res.end();
    }
};


XDmvcServer.prototype.idIsFree = function(id) {
    return (!this.peers[id]);
};

XDmvcServer.prototype.start = function(portPeer, portSocketIo, portAjax) {
    portPeer = portPeer? portPeer : 9000;
    portAjax = portAjax? portAjax : 9001;
    portSocketIo = portSocketIo? portSocketIo : 3000;

    this.startPeerSever(portPeer);
    this.startSocketIoServer(portSocketIo);
    this.startAjaxServer(portAjax);
};

module.exports = XDmvcServer;

