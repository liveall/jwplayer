define(['../utils/underscore',
    '../utils/id3Parser',
    '../utils/helpers',
    '../parsers/parsers',
    '../parsers/captions/srt',
    '../parsers/captions/dfxp'
], function(_, ID3Parser, utils, parsers, srt, dfxp) {
    /**
     * Used across all providers for loading tracks and handling browser track-related events
     */
    var Tracks = {
        _itemTracks: null,
        _textTracks: null,
        _tracksById: null,
        _cuesByTrackId: null,
        _metaCuesByTextTime: null,
        _currentTextTrackIndex: -1,
        _unknownCount: 0,
        _renderNatively: false,
        _activeCuePosition: null,
        addTracksListener: addTracksListener,
        clearTracks: clearTracks,
        disableTextTrack: disableTextTrack,
        getSubtitlesTrack: getSubtitlesTrack,
        removeTracksListener: removeTracksListener,
        addTextTracks: addTextTracks,
        setTextTracks: setTextTracks,
        setupSideloadedTracks: setupSideloadedTracks,
        setSubtitlesTrack: setSubtitlesTrack,
        textTrackChangeHandler: null,
        addCuesToTrack: addCuesToTrack,
        addCaptionsCue: addCaptionsCue,
        addVTTCue: addVTTCue
    };

    function setTextTracks(tracks) {
        this._currentTextTrackIndex = -1;

        if (!tracks) {
            return;
        }

        if (!this._textTracks) {
            _initTextTracks.call(this);
        }

        // filter for 'subtitles' or 'captions' tracks
        if (tracks.length) {
            var i = 0, len = tracks.length;

            for (i; i < len; i++) {
                var track = tracks[i];
                if (!track._id) {
                    if (track.kind === 'captions' || track.kind === 'metadata') {
                        track._id = 'native' + track.kind;
                    } else {
                        track._id = createTrackId.call(this, track);
                    }
                    track.inuse = true;
                }
                if (!track.inuse || this._tracksById[track._id]) {
                    continue;
                }
                // setup TextTrack
                if (track.kind === 'metadata') {
                    // track mode needs to be "hidden", not "showing", so that cues don't display as captions in Firefox
                    track.mode = 'hidden';
                    track.oncuechange = _cueChangeHandler.bind(this);
                    this._tracksById[track._id] = track;
                }
                else if (_kindSupported(track.kind)) {
                    var mode = track.mode,
                        cue;

                    // By setting the track mode to 'hidden', we can determine if the track has cues
                    track.mode = 'hidden';

                    if (!track.cues.length && track.embedded) {
                        // There's no method to remove tracks added via: video.addTextTrack.
                        // This ensures the 608 captions track isn't added to the CC menu until it has cues
                        continue;
                    }

                    track.mode = mode;

                    // Parsed cues may not have been added to this track yet
                    if (this._cuesByTrackId[track._id] && !this._cuesByTrackId[track._id].loaded) {
                        var cues = this._cuesByTrackId[track._id].cues;
                        while ((cue = cues.shift())) {
                            track.addCue(cue);
                        }
                        track.mode = mode;
                        this._cuesByTrackId[track._id].loaded = true;
                    }

                    _addTrackToList.call(this, track);
                }
            }
        }

        if (this._renderNatively) {
            // Only bind and set this.textTrackChangeHandler once so that removeEventListener works
            this.textTrackChangeHandler = this.textTrackChangeHandler || textTrackChangeHandler.bind(this);

            this.removeTracksListener(this.video.textTracks, 'change', this.textTrackChangeHandler);
            this.addTracksListener(this.video.textTracks, 'change', this.textTrackChangeHandler);
        }

        if (this._textTracks.length) {
            this.trigger('subtitlesTracks', {tracks: this._textTracks});
        }
    }

    function setupSideloadedTracks(itemTracks) {
        // Determine if the tracks are the same and the embedded + sideloaded count = # of tracks in the controlbar
        var alreadyLoaded = itemTracks === this._itemTracks;
        if (!alreadyLoaded) {
            _cancelXhr(this._itemTracks);
        }
        this._itemTracks = itemTracks;
        if (!itemTracks) {
            return;
        }
        
        if (!alreadyLoaded) {
            // Add tracks if we're starting playback or resuming after a midroll
            this._renderNatively = _nativeRenderingSupported(this.getName().name);
            if (this._renderNatively) {
                this.disableTextTrack();
                _clearSideloadedTextTracks.call(this);
            }
            this.addTextTracks(itemTracks);
        }
    }

    function getSubtitlesTrack() {
        return this._currentTextTrackIndex;
    }

    function setSubtitlesTrack(menuIndex) {
        if (!this._textTracks) {
            return;
        }

        // 0 = 'Off'
        if (menuIndex === 0) {
            _.each(this._textTracks, function (track) {
                track.mode = 'disabled';
            });
        }

        // Track index is 1 less than controlbar index to account for 'Off' = 0.
        // Prevent unnecessary track change events
        if (this._currentTextTrackIndex === menuIndex - 1) {
            return;
        }

        // Turn off current track
        this.disableTextTrack();

        // Set the provider's index to the model's index, then show the selected track if it exists
        this._currentTextTrackIndex = menuIndex - 1;

        if (this._renderNatively) {
            if (this._textTracks[this._currentTextTrackIndex]) {
                this._textTracks[this._currentTextTrackIndex].mode = 'showing';
            }

            // Update the model index since the track change may have come from a browser event
            this.trigger('subtitlesTrackChanged', {
                currentTrack: this._currentTextTrackIndex + 1,
                tracks: this._textTracks
            });
        }
    }

    function addCaptionsCue(cueData) {
        if (!cueData.text || !cueData.begin || !cueData.end) {
            return;
        }
        var trackId = cueData.trackid.toString();
        var track = this._tracksById && this._tracksById[trackId];
        if (!track) {
            track = {
                kind: 'captions',
                _id: trackId,
                data: []
            };
            this.addTextTracks([track]);
            this.trigger('subtitlesTracks', {tracks: this._textTracks});
        }

        var cueId;

        if (cueData.useDTS) {
            // There may not be any 608 captions when the track is first created
            // Need to set the source so position is determined from metadata
            if (!track.source) {
                track.source = cueData.source || 'mpegts';
            }

        }
        cueId = cueData.begin + '_' + cueData.text;

        var cue = this._metaCuesByTextTime[cueId];
        if (!cue) {
            cue = {
                begin: cueData.begin,
                end: cueData.end,
                text: cueData.text
            };
            this._metaCuesByTextTime[cueId] = cue;
            var vttCue = _convertToVTTCues([cue])[0];
            track.data.push(vttCue);
        }
    }

    function addVTTCue(cueData) {

        var trackId = 'native' + cueData.type,
            track = this._tracksById[trackId],
            label = cueData.type === 'captions' ? 'Unknown CC' : 'ID3 Metadata';

        if (!track) {
            var itemTrack = {
                kind: cueData.type,
                _id: trackId,
                label: label,
                embedded: true
            };
            track = _createTrack.call(this, itemTrack);
            if (this._renderNatively || track.kind === 'metadata') {
                this.setTextTracks(this.video.textTracks);
            } else {
                track.data = [];
                addTextTracks.call(this, [track]);
            }
        }

        if (this._renderNatively || track.kind === 'metadata') {
            track.addCue(cueData.cue);
        } else {
            track.data.push(cueData.cue);
        }
    }

    function addCuesToTrack(cueData) {
        // convert cues coming from the flash provider into VTTCues, then append them to track
        var track = this._tracksById[cueData.name];
        if (!track) {
            return;
        }

        track.source = cueData.source;
        var cues = cueData.captions || [],
            cuesToConvert = [],
            sort = false;
        for (var i=0; i<cues.length; i++) {
            var cue = cues[i];
            var cueId = cueData.name +'_'+ cue.begin +'_'+ cue.end;
            if (!this._metaCuesByTextTime[cueId]) {
                this._metaCuesByTextTime[cueId] = cue;
                cuesToConvert.push(cue);
                sort = true;
            }
        }
        if (sort) {
            cuesToConvert.sort(function(a, b) {
                return a.begin - b.begin;
            });
        }
        var vttCues = _convertToVTTCues(cuesToConvert);
        Array.prototype.push.apply(track.data, vttCues);
    }

    function addTracksListener(tracks, eventType, handler) {
        if (!tracks) {
            return;
        }

        if (tracks.addEventListener) {
            tracks.addEventListener(eventType, handler);
        } else {
            tracks['on' + eventType] = handler;
        }
    }

    function removeTracksListener(tracks, eventType, handler) {
        if (!tracks) {
            return;
        }
        if (tracks.removeEventListener) {
            tracks.removeEventListener(eventType, handler);
        } else {
            tracks['on' + eventType] = null;
        }
    }

    function clearTracks() {
        _cancelXhr(this._itemTracks);
        var metadataTrack = this._tracksById && this._tracksById.nativemetadata;
        if (this._renderNatively || metadataTrack) {
            _removeCues.call(this, this.video.textTracks);
            if(metadataTrack) {
               metadataTrack.oncuechange = null;
            }
        }
        this._itemTracks = null;
        this._textTracks = null;
        this._tracksById = null;
        this._cuesByTrackId = null;
        this._metaCuesByTextTime = null;
        this._unknownCount = 0;
        this._activeCuePosition = null;
    }

    function disableTextTrack() {
        if (this._textTracks && this._textTracks[this._currentTextTrackIndex]) {
            this._textTracks[this._currentTextTrackIndex].mode = 'disabled';
        }
    }

    function textTrackChangeHandler() {
        var textTracks = this.video.textTracks;
        var inUseTracks = _.filter(textTracks, function (track)  {
            return (track.inuse || !track._id) && _kindSupported(track.kind);
        });
        if (!this._textTracks || inUseTracks.length > this._textTracks.length) {
            // If the video element has more tracks than we have internally..
            this.setTextTracks(textTracks);
        }
        // If a caption/subtitle track is showing, find its index
        var selectedTextTrackIndex = -1, i = 0;
        for (i; i < this._textTracks.length; i++) {
            if (this._textTracks[i].mode === 'showing') {
                selectedTextTrackIndex = i;
                break;
            }
        }
        // Notifying the model when the index changes keeps the current index in sync in iOS Fullscreen mode
        if (selectedTextTrackIndex !== this._currentTextTrackIndex) {
            this.setSubtitlesTrack(selectedTextTrackIndex + 1);
        }
    }

    function addTextTracks(tracksArray) {
        if (!tracksArray) {
            return;
        }

        if (!this._textTracks) {
            _initTextTracks.call(this);
        }

        this._renderNatively = _nativeRenderingSupported(this.getName().name);

        for (var i = 0; i < tracksArray.length; i++) {
            var itemTrack = tracksArray[i];
            // only add valid and supported kinds https://developer.mozilla.org/en-US/docs/Web/HTML/Element/track
            if (itemTrack.kind && !_kindSupported(itemTrack.kind)) {
                continue;
            }
            var textTrackAny = _createTrack.call(this, itemTrack);
            _addTrackToList.call(this, textTrackAny);
            if (itemTrack.file) {
                itemTrack.data = [];
                itemTrack.xhr = _loadTrack.call(this, itemTrack, textTrackAny);
            }
        }

        // We can setup the captions menu now since we're not rendering textTracks natively
        if (!this._renderNatively && this._textTracks && this._textTracks.length) {
            this.trigger('subtitlesTracks', {tracks: this._textTracks});
        }
    }

    function _cancelXhr(itemTracks) {
        _.each(itemTracks, function(itemTrack) {
            var xhr = itemTrack.xhr;
            if (xhr) {
                xhr.onload = null;
                xhr.onreadystatechange = null;
                xhr.onerror = null;
                if ('abort' in xhr) {
                    xhr.abort();
                }
            }
        });
    }

    function createTrackId(track) {
        var trackId;
        var prefix = track.kind || 'cc';
        if (track.default || track.defaulttrack) {
            trackId = 'default';
        } else {
            trackId = track._id|| track.name || track.file || track.label || (prefix + this._textTracks.length);
        }
        return trackId;
    }

    //////////////////////
    ////// PRIVATE METHODS
    //////////////////////

    function _removeCues(tracks) {
        if (tracks.length) {
            _.each(tracks, function(track) {
                // Cues are inaccessible if the track is disabled. While hidden,
                // we can remove cues while the track is in a non-visible state
                track.mode = 'hidden';
                for (var i = track.cues.length; i--;) {
                    track.removeCue(track.cues[i]);
                }
                track.mode = 'disabled';
                track.inuse = false;
            });
        }
    }

    function _nativeRenderingSupported(providerName) {
        return providerName.indexOf('flash') === -1 && (utils.isChrome() || utils.isIOS() || utils.isSafari());
    }

    function _kindSupported(kind) {
        return kind === 'subtitles' || kind === 'captions';
    }

    function _initTextTracks() {
        this._textTracks = [];
        this._tracksById = {};
        this._metaCuesByTextTime = {};
        this._cuesByTrackId = {};
        this._unknownCount = 0;
    }

    function _createTrack(itemTrack) {
        var track;
        var label = _createLabel.call(this, itemTrack);
        if (this._renderNatively || itemTrack.kind === 'metadata') {
            var tracks = this.video.textTracks;
            // TextTrack label is read only, so we'll need to create a new track if we don't
            // already have one with the same label
            track = _.findWhere(tracks, {'label': label});

            if (track) {
                track.kind = itemTrack.kind;
                track.label = label;
                track.language = itemTrack.language || '';
            } else {
                track = this.video.addTextTrack(itemTrack.kind, label, itemTrack.language || '');
            }
            track.default = itemTrack.default;
            track.mode    = 'disabled';
            track.inuse = true;
        } else {
            track = itemTrack;
            track.data = track.data || [];
        }

        if (!track._id) {
            track._id = createTrackId.call(this, itemTrack);
        }

        return track;
    }

    function _createLabel(track) {
        var label = track.label || track.name || track.language;
        if (!label) {
            label = 'Unknown CC';
            this._unknownCount++;
            if (this._unknownCount > 1) {
                label += ' [' + this._unknownCount + ']';
            }
        }
        return label;
    }

    function _addTrackToList(track) {
        this._textTracks.push(track);
        this._tracksById[track._id] = track;
    }

    function _loadTrack(itemTrack, track) {
        var _this = this;
        return utils.ajax(itemTrack.file, function(xhr) {
            _xhrSuccess.call(_this, xhr, track);
        }, _errorHandler);
    }

    function _clearSideloadedTextTracks() {
        // Clear VTT textTracks
        if (!this._textTracks) {
            return;
        }
        var nonSideloadedTracks = _.filter(this._textTracks, function (track) {
            return track.embedded || track.groupid === 'subs';
        });
        _initTextTracks.call(this);
        _.each(nonSideloadedTracks, function (track) {
            this._tracksById[track._id] = track;
        });
        this._textTracks = nonSideloadedTracks;
    }

    function _addVTTCuesToTrack(track, vttCues) {
        if (this._renderNatively) {
            var textTrack = this._tracksById[track._id];
            // the track may not be on the video tag yet
            if (!textTrack) {

                if (!this._cuesByTrackId) {
                    this._cuesByTrackId = {};
                }
                this._cuesByTrackId[track._id] = { cues: vttCues, loaded: false};
                return;
            }
            // Cues already added
            if (this._cuesByTrackId[track._id] && this._cuesByTrackId[track._id].loaded) {
                return;
            }

            var cue;
            this._cuesByTrackId[track._id] = { cues: vttCues, loaded: true };

            while((cue = vttCues.shift())) {
                textTrack.addCue(cue);
            }
        } else {
            track.data = vttCues;
        }
    }

    function _convertToVTTCues(cues) {
        // VTTCue is available natively or polyfilled where necessary
        var VTTCue = window.VTTCue;
        var vttCues = _.map(cues, function (cue) {
            return new VTTCue(cue.begin, cue.end, cue.text);
        });
        return vttCues;
    }

    function _parseCuesFromText(srcContent, track) {
        var renderNatively = this._renderNatively;
        require.ensure(['../parsers/captions/vttparser'], function (require) {
            var VTTParser = require('../parsers/captions/vttparser');
            var parser = new VTTParser(window);
            if (renderNatively) {
                parser.oncue = function(cue) {
                    track.addCue(cue);
                };
            } else {
                track.data = track.data || [];
                parser.oncue = function(cue) {
                    track.data.push(cue);
                };
            }

            try {
                parser.parse(srcContent).flush();
            } catch(error) {
                _errorHandler(error);
            }

        }, 'vttparser');
    }

    function _cueChangeHandler(e) {
        var activeCues = e.currentTarget.activeCues;
        if (!activeCues || !activeCues.length) {
            return;
        }

        // Get the most recent start time. Cues are sorted by start time in ascending order by the browser
        var startTime = activeCues[activeCues.length - 1].startTime;
        //Prevent duplicate meta events for the same list of cues since the cue change handler fires once
        // for each activeCue in Safari
        if (this._activeCuePosition === startTime) {
            return;
        }
        var dataCues = [];

        _.each(activeCues, function(cue) {
            if (cue.startTime < startTime) {
                return;
            }
            if (cue.data || cue.value) {
                dataCues.push(cue);
            } else if (cue.text) {
                this.trigger('meta', {
                    metadataTime: startTime,
                    metadata: JSON.parse(cue.text)
                });
            }
        }, this);

        if (dataCues.length) {
            var id3Data = ID3Parser.parseID3(dataCues);
            this.trigger('meta', {
                metadataTime: startTime,
                metadata: id3Data
            });
        }
        this._activeCuePosition = startTime;
    }

    function _xhrSuccess(xhr, track) {
        var xmlRoot = xhr.responseXML ? xhr.responseXML.firstChild : null;
        var cues, vttCues;

        // IE9 sets the firstChild element to the root <xml> tag
        if (xmlRoot) {
            if (parsers.localName(xmlRoot) === 'xml') {
                xmlRoot = xmlRoot.nextSibling;
            }
            // Ignore all comments
            while (xmlRoot.nodeType === xmlRoot.COMMENT_NODE) {
                xmlRoot = xmlRoot.nextSibling;
            }
        }
        try {
            if (xmlRoot && parsers.localName(xmlRoot) === 'tt') {
                // parse dfxp track
                cues = dfxp(xhr.responseXML);
                vttCues = _convertToVTTCues(cues);
                _addVTTCuesToTrack.call(this, track, vttCues);
            } else {
                // parse VTT/SRT track
                var responseText = xhr.responseText;

                // TODO: parse SRT with using vttParser and deprecate srt module
                if (responseText.indexOf('WEBVTT') >= 0) {
                    // make VTTCues from VTT track
                    _parseCuesFromText.call(this, responseText, track);
                } else {
                    // make VTTCues from SRT track
                    cues = srt(responseText);
                    vttCues = _convertToVTTCues(cues);
                    _addVTTCuesToTrack.call(this, track, vttCues);
                }
            }
        } catch (error) {
            _errorHandler(error.message + ': ' + track.file);
        }
    }

    function _errorHandler(error) {
        utils.log('CAPTIONS(' + error + ')');
    }

    return Tracks;
});
