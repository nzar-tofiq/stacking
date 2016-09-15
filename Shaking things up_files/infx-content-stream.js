"use strict";	// using strict JavaScript for this now

// create the _infx namespace if it doesn't exist already
_infx = ( typeof(_infx) === 'undefined' ) ? {} : _infx;

// content stream filtering system +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
_infx.content_stream = {
	// > properties
	// this property indicates we are in the middle of loading data from the backend, and
	// will block any additional attempts until the backend has come back to us & the state
	// has been updated.
	locked: false,

	// various JQ selectors used within the javascript below, saves us duplicating these
	// all over the place & makes it easier to change these.
	selectors: {
		system:		'.content-stream-system',
		wrapper:	'.content-stream-article-wrapper',
		items:		'.content-stream-article-wrapper .content-stream-article-item'
	},

	event_namespace: 'content-stream',

	// used to store timers for - [infinite-scrolling]
	timers: {},

	// state properties - infinite scrolling has been de-prioritised in favour of other
	// elements see [infinite-scrolling] for the full set of commented out elements.
	state: {
		lastIndex:			null,
		itemHeight:			null,
		itemsPerRow:		null,
		direction:			0,
		scrollTop:			0,
		screenOffset:		0,
		lastIndex:			0,
		lastIndexReceived:	0,
		lastScreenOffset:	0,
		lastScrollTop:		0,
		maxRows:			0,
		maxScrollTop:		0,
		loadAmount:			0,
		requiredRows:		0,
		itemsLoaded:		0,
		wrapperTopOffset:	0,
		loadThresholdScrollTop: 0,
		requestedRows:		0,
		loadedEverything:	false,
		wrapperHeight:		null
	},

	// used to keep track of the data indexes we have loaded from the backend - [infinite-scrolling]
	requests: [],

	// > functions
	// _infx.content_stream.init
	// initialisation process occurs once after document ready event has been triggered
	init: function () {
		var _self = this;

		// add events we want to persist between interface updates
		_self.apply_filters_from_location_hash();

		// add events we want to persist between interface updates
		_self.setup_events();

		// add events we want to persist between interface updates
		_self.setup_handlebars();
	},


	// _infx.content_stream.setup_handlebars
	// checks to see if we have handlebars loaded already, if not we attempt to dynamically
	// load the script on the fly, we wait for it to load, then trigger the rest of the
	// initialisation process.
	setup_handlebars: function(){
		var _self = this;

		// do we have a Handlebars object loaded, if not we must fetch it here
		if ( typeof Handlebars === 'undefined' ) {
			$.getScript( "/script/handlebars.js/3.0.3/handlebars.min.js", function(){
				// register handlebars partials
				_self.register_handlebars_partials();

				// register handlebars helpers
				_self.register_handlebars_helpers();

				// fetch the data from the backend and build the interface
				_self.update();
			} );
		} else {
			// register handlebars partials
			_self.register_handlebars_partials();

			// register handlebars helpers
			_self.register_handlebars_helpers();

			// check we have the right version, TBC - is there an upper limit?
			if ( parseFloat( Handlebars.VERSION ) >= 3.0 ) {
				_self.update();
			} else {
				console.error('unable to initialise the filtering system, please ensure the correct version of Handlebars is loaded we require at least v3.0');
			};
		};
	},


	// _infx.content_stream.setup_events
	// this part of the initialisation process deals with assigning events for content
	// stream functionality such as the sub category expander, it also includes events for
	// the [infinite-scrolling] logic, google GA event tracking & UI components for the
	// user to modify the current filter state.
	setup_events: function(){
		var _self = this;

		// this technique of adding events allows us to add events once & have them
		// persisted even if the content changes via Ajax / Handlebars updates.

		// expand category filter
		$( _self.selectors.system ).on( "click." + _self.event_namespace, ".available-filter-group .icon-arrow-down", function(){
			$( this ).parent().toggleClass('filter-group-open');
		} );

		// content stream filtering system changes
		$( _self.selectors.system ).on( "click." + _self.event_namespace, "[data-content-stream-filter-mode]", function(){
			// trigger an event which will update the filtering state based on this interaction
			_self.trigger_event( $( this ).data('content-stream-filter-mode'), $( this ).data('content-stream-property'), $( this ).data('content-stream-tag'), 0 );

			// Google Analytics [GA] - event tracking for the filtering system
			_infx.track.fire( 'event', [ $( this ).data('content-stream-filter-mode') + "-filter", $( this ).data('content-stream-property'), $( this ).data('content-stream-tag') ] );

			// after the change to the filters we need to re poll the backend for an
			// updated set of available filters & news articles which match the new
			// filters.
			_self.update();
		} );

		// setup scrolling event - [infinite-scrolling]
		$( window ).on( "scroll." + _self.event_namespace, function() {
			clearTimeout( _self.timers.scroll );
			_self.timers.scroll = setTimeout( function () {
				_self.on_scroll_event( $( window ) );
			}, 333 ); // delay of 100ms so we don't constantly call this
		}).on( "resize." + _self.event_namespace, function() {
			// TBD - I'm not sure why we can't use the same event for resize & on scroll,
			// there does seem to be a fair amount of similarities with duplicated maths
			// which will make maintaining this harder IMO.
			clearTimeout( _self.timers.resizeTimer );
			_self.timers.resizeTimer = setTimeout( function() {
				var $news_article_item = $( _self.selectors.items ).eq( 0 );
				_self.state.itemHeight = $news_article_item.outerHeight( true );
				_self.state.screenOffset = Math.floor( _self.state.scrollTop / _self.state.itemHeight );
				_self.state.itemsPerRow = Math.floor( $( _self.selectors.wrapper ).width() / $news_article_item.outerWidth( true ) );
				_self.state.maxRows = Math.ceil( _self.state.lastIndex / _self.state.itemsPerRow );
				_self.state.wrapperHeight = ( _self.state.maxRows * _self.state.itemHeight );
				//$( _self.selectors.wrapper ).css( { 'height': _self.state.wrapperHeight + 'px' , "display" : "table" } );
				$( _self.selectors.wrapper ).css( { 'height': _self.state.wrapperHeight + 'px' } );
			}, 500 );
		});
	},


	// _infx.content_stream.on_scroll_event - [infinite-scrolling]
	// on scroll & resize events automatically triggered as required to maintain various
	// state variables relating to infinite scrolling.
	on_scroll_event: function( $window ) {
		var _self = this;

		if( _self.state.loadedEverything === true ) return;

		// setup initial properties (only fired once)
		// TBD - need to change this to check for initialisation, as sometimes we won't have
		// any articles (think no items returned)
		var $news_article_item = $( _self.selectors.items ).eq( 0 );
		if( $news_article_item.length == 0 ) {
			// we are not ready yet, so call back after 50ms as we must wait until articles
			// have been loaded before we can continue.
			setTimeout( function () { _self.on_scroll_event( $( window ) ); }, 50 );
			return;
		};

		// begin initialise state - these must updated after each new scroll event -+-+-+-

		// current scroll position
		_self.state.scrollTop = $window.scrollTop();
		_self.state.itemHeight = $news_article_item.outerHeight( true );
		_self.state.screenOffset = Math.floor( _self.state.scrollTop / _self.state.itemHeight );
		_self.state.itemsPerRow = Math.floor( $( _self.selectors.wrapper ).width() / $news_article_item.outerWidth( true ) );
		_self.state.itemsLoadedAndRequested = $( _self.selectors.items ).length;
		_self.state.itemsLoaded = $( _self.selectors.items ).not(".placeholder").length;
		_self.state.rowsLoaded = _self.state.itemsLoaded / _self.state.itemsPerRow;
		_self.state.wrapperTopOffset = $( _self.selectors.wrapper ).offset().top;
		_self.state.loadThresholdScrollTop = ( ( _self.state.itemsLoadedAndRequested / _self.state.itemsPerRow ) * _self.state.itemHeight ) + _self.state.wrapperTopOffset - $window.height();
		_self.state.lastLoadedItemIndex = _self.state.itemsLoaded - 1;
		_self.state.lastLoadedAndRequestedItemIndex = _self.state.itemsLoadedAndRequested - 1;
		_self.state.maxRows = Math.ceil( _self.state.lastIndex / _self.state.itemsPerRow );
		_self.state.scrollHeightDiff = ( _self.state.scrollTop - _self.state.lastScrollTop );



		// keep track of how far down the listing we have travelled after each scroll
		if ( _self.state.scrollTop > _self.state.maxScrollTop ) {
			_self.state.maxScrollTop = _self.state.scrollTop;
		}

		// ensure the wrapper height is set to the maximum possible height of all items
		// returned, this ensures the scroll bar doesn't jump around as we load items &
		// also gives the user an idea of how many items they are likely to get using current
		// filters.
		_self.state.wrapperHeight = ( _self.state.maxRows * _self.state.itemHeight );
		//$( _self.selectors.wrapper ).css( { 'height': _self.state.wrapperHeight + 'px' , "display" : "table" } );
		$( _self.selectors.wrapper ).css( { 'height': _self.state.wrapperHeight + 'px' } );
		// work out the scroll direction, don't really need this atm as we are only concerned with one direction
		_self.state.direction = ( ( _self.state.scrollTop - _self.state.lastScrollTop ) > 0 ) ? 1 : -1;

		// end initialise state -+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
		var new_rows = 0;

		if( _self.state.scrollTop > _self.state.loadThresholdScrollTop ) {
			_self.state.scrollHeightDiff = _self.state.scrollTop - _self.state.loadThresholdScrollTop;
			new_rows = Math.ceil( _self.state.scrollHeightDiff / _self.state.itemHeight );
			//console.log("DK load %d new rows" , new_rows);
		}

		// have we've moved far enough to warrent a load?
		if( new_rows > 0 ) {
			// load place holder items

			_self.state.loadThresholdScrollTop = _self.state.scrollTop;

			// request the next N items
			var requestStartIndex = _self.state.lastLoadedAndRequestedItemIndex + 1;
			var requestEndIndex = _self.state.lastLoadedAndRequestedItemIndex + ( new_rows * _self.state.itemsPerRow );

			if( requestEndIndex > _self.state.lastIndex) {
				requestEndIndex = _self.state.lastIndex;
				_self.state.loadedEverything = true;
			}

			if( requestStartIndex > _self.state.lastIndex) { _self.state.loadedEverything = true; return; }

			//console.info( "need to load %d new rows", new_rows );

			if( _self.already_requested( requestStartIndex , requestEndIndex ) === false ) {
				//console.log("requesting!");
				// load place holders
				_self.load_place_holders( requestStartIndex, requestEndIndex );
				// load the actual article content
				_self.load_next( requestStartIndex , requestEndIndex );
			} else {
				//console.log("not requesting anything as these indexes are already requested...");
			}
		}
	},


	// _infx.content_stream.already_requested
	// TBD - look at implementing this more cleanly with logic applied to the existing state..
	// this maintains a list of all the article indexes we have loaded & is used to help us
	// work out when to load new data.
	already_requested: function ( start_idx, end_idx ) {
		var _self = this;
		var success = false;
		$.each( _self.requests , function( index , value ) {
			var val = _self.requests[index];
			if( (val.startIndex === start_idx) && (val.endIndex === end_idx) ) {
				success = true;
			}
			if( (val.startIndex <= start_idx) && (val.endIndex >= end_idx) ) {
				success = true;
			}
		});
		return success;
	},


	// _infx.content_stream.load_place_holders
	// loads temporary place holder divs, while we head off to the server to collect the
	// real article content, this makes the front end feel far more responsive & also
	// allows us to indicate new content will soon appear.
	load_place_holders: function ( start_idx, end_idx ) {
		//console.log( "request the next %d place holders, indexes from %d to %d", ( end_idx - start_idx ), start_idx, end_idx );
		$( _self.selectors.wrapper + ' div.clear').remove();
		$( _self.selectors.wrapper ).append( function(){
			var html = "";
			for ( var x=start_idx;x<end_idx+1;x++ ){
				html += "<div class='content-stream-article-item placeholder' data-index='"+x+"'><div class='spinner-loader'></div></div>";
			}
			html += "<div class='clear'></div>";
			return html;
		} );
	},


	// _infx.content_stream.load_next - [infinite-scrolling]
	// once we've identified the need to load additional content stream articles this
	// function is invoked to call the back end widget for the next set of articles.
	load_next: function ( start_idx, end_idx ) {
		//console.log( "request the next %d items, indexes from %d to %d", ( end_idx - start_idx + 1 ), start_idx, end_idx );
		var _self = this;

		// reset this ready for the next scroll event
		_self.state.lastScrollTop = _self.state.scrollTop;
		_self.state.lastScreenOffset = _self.state.screenOffset;
		var amount = ( end_idx - start_idx + 1 );
		var requestedRows = amount / _self.state.itemsPerRow;
		_self.state.requestedRows += requestedRows;
		//console.log( "requested rows : %d   total requested rows: %d " , requestedRows , _self.state.requestedRows );

		//console.log( "requesting! %d items from %d to %d" , amount , start_idx , end_idx );
		_self.requests.push({
			"startIndex": 		start_idx,
			"endIndex":			end_idx,
			"requestedRows":	requestedRows,
			"success":			false
		});

		// fetch the data from the back end, then compile the template using the data
		// from the back end
		_self.get_data( { ac: 'filter_system_data', mode: 'articles', start: start_idx, limit: amount }, function( context ){
			// fires after the data has been loaded from the back end
			//console.log(context);
			_self.compiler( '#content-listing-template',  _self.selectors.wrapper , context, true );

			_self.post_update( context.last );
		} );
	},


	// _infx.content_stream.apply_filters_from_location_hash
	// this allows us to specify additional information on the /news/ url to filter by
	// a particular property & tag combination. It's now possible to stack these filters
	// Please see the following examples:
	// /news/#clear/pillars:Cognition - will clear then add a filter for property: pillars tag: Cognition
	// /news/#clear/pillars:Cognition/subcategories:Protein - will clear then add filters for property: pillars tag: Cognition & property: subcategories tag: Protein
	apply_filters_from_location_hash: function(){
		var _self = this;

		if ( location.hash ){
			var filters = unescape( location.hash ).replace(/^#/g,"").split( "/" );
			$.each( filters, function ( idx, filter ) {
				if ( filter == 'clear' ) {
					// reset the existing filters
// 					console.warn('clear existing filters');
					_self.storage( 'save', [] );
				} else {
					var matches = filter.match( /^([\w]+):([\w -\.']+)$/i );
					if ( matches && matches.length == 3 ){
						// looks like a valid filter so lets unpack the elements
						var property = matches[1];
						var tag = matches[2];

						// with experts, featuring & pillars we replace the existing filter for
						// everything else they will be additive, unless the clear tag is found
						// this may need to change now we can specify multiple filters, but
						// I'm conscious this could change behaviour :(
						var mode = ( property.search(/^(pillars|experts|featuring)$/) != -1 ) ? 'replace' : 'add';

// 						console.log( "mode", mode, "property:", property, "tag:", tag );
						_self.trigger_event( mode, property, tag, 1 );
					} else {
						console.warn("[invalid] - unable to apply hash filter, format looks wrong so ignoring");
					};
				}
			} );
		};
	},


	// _infx.content_stream.trigger_event
	// called when the user has requested a change to the current filters applied to content
	// stream articles, it's called via events added within the setup_events function and
	// also when we have filters defined by the location hash see - apply_filters_from_location_hash
	trigger_event: function( mode, property, tag, ignore_lock ){
		var _self = this;

		if ( _self.locked && ! ignore_lock ){
			// simple locking to ensure we don't trigger too many adds, hopefully local
			// storage is super fast and we don't need this.
			console.warn("[wait] - still waiting for previous change to be reflected in the interface.");
			return false;
		}

		// lock the interface so no further updates are made to the filtering before
		// we polled the back end.
		_self.locked = true;

		// fetch the current filter state from local storage
		var contentFilters = _self.storage( 'load', undefined, false );

		var newContentFilters = [];
		var already_present = false;

		$.each( contentFilters, function( index, filter ) {
			if ( mode == 'remove' ) {
				if ( filter.property != property || filter.tag != tag ) {
					newContentFilters.push( filter );	// not the one we want to remove
				}
			}else if ( mode == 'add' && filter.property == property && filter.tag == tag ) {
				already_present = true;
				return false;
			}else if ( mode == 'replace' ) {
				if ( filter.property != property ){
					// not the property we are replacing so push this item
					newContentFilters.push( filter );
				}
			}
		} );

		if ( mode == 'remove' || mode == 'replace' ) {
			if( mode == 'replace' && tag !== '' ){	// ignore the empty tag linked for ALL pillars
				// push the replacement item, the newContentFilters array should only
				// contain other properties by this point
				newContentFilters.push( { property: property, tag: tag } );
			}
			contentFilters = newContentFilters;
		} else if ( mode == 'add' && ! already_present ) {
			contentFilters.push( { property: property, tag: tag } );
		}

		_self.storage( 'save', contentFilters );
	},


	// _infx.content_stream.storage
	// simple function to wrap the browser storage logic, we currently use the HTML5 session
	// storage mechanic which will remain until the user closes all browser windows linked
	// to a particular browser session, mode indicates if we are loading "load" or saving
	// "save" to browser storage. The opt_raw argument is only used when loading and allows
	// you to collect the RAW JSON string for the state without a parse, this is vital when
	// communicating the current interface state to the backend.
	storage: function ( mode, data, opt_raw ){
		var _self = this;

		// http://www.w3schools.com/html/html5_webstorage.asp
		// we can use localStorage (if we want this data to persist longer than an individual
		// session, or sessionStorage if we don't, opting for sessionStorage for now :)
		if ( 'sessionStorage' in window && window['sessionStorage'] !== null ) {
			if ( mode == 'load' ) {
				var contentFilters = sessionStorage.getItem("contentFilters") || "[]"
				return ( opt_raw ) ? contentFilters : JSON.parse( contentFilters );
			} else if ( mode == 'save' ){
				sessionStorage.setItem( "contentFilters", JSON.stringify( data ) );
			}
		}else{
			console.error("[fatal] - session storage is required by the filtering system to maintain state.");
			// we could maybe try and store this in a cookie instead, or backend if we
			// find browsers which we want to support which don't support this logic.
		}
	},


	// _infx.content_stream.register_handlebars_helpers
	// any handlebars helpers should be defined here, separated to break down the
	// initialisation process.
	register_handlebars_helpers: function () {
		var _self = this;

		// this helper is called within the content-stream-template template & it's
		// responsible for comparing two properties or a sting & a property and returning
		// a true false value if they match. It's intended for use within an #if or #unless
		// block
		Handlebars.registerHelper("equal_to", function( a, b ) {
			return ( a === b) ? true : false;
		} );

		// this helper is called within various templates & is responsible for converting
		// a single supplied argument into a valid css class, currently it's quite
		// simplistic and simply lowercases the supplied argument and converts spaces to
		// hyphens
		Handlebars.registerHelper("make_class", function( data ) {
			data = String( data ).toLowerCase().replace(/ +/g, "-");
			return data;
		} );

		Handlebars.registerHelper("property_tag_list", function( property, join_html, article ) {
			var tags = [];
			$.each( article.tags, function ( idx, tag_rec ) {
				if ( tag_rec.property === property ) {
					tags.push( tag_rec.tag );
				};
			} );
			return tags.join( join_html );
		} );

		Handlebars.registerHelper("is_tagged", function( property, tag, article ) {
			var result = false;
			$.each( article.tags, function ( idx, tag_rec ) {
				if ( tag_rec.property === property && tag_rec.tag === tag ) {
					result = true;
				};
			} );
			return result;
		} );
	},


	// _infx.content_stream.register_handlebars_partials
	// any partial handlebars templates should be defined here, separated to break down the
	// initialisation process.
	register_handlebars_partials: function () {
		var _self = this;

		// this helper is called within the content-stream-template template & allows
		// us to have a single template to render the initial filter interface & so we
		// can render individual articles for infinite scrolling
		Handlebars.registerPartial('article', $("#content-listing-template").html() );
	},


	// _infx.content_stream.update
	// called each time we need to reload the data from the back end, this occurs on initial
	// load & also after a change of filters.
	update: function () {
		var _self = this;

		// fetch the data from the back end, then compile the template using the data
		// from the back end
		_self.get_data( { ac: 'filter_system_data' }, function( context ){
			// fires after the data has been loaded from the back end
			_self.compiler( '#content-stream-template', _self.selectors.system, context );

			_self.post_update( context.last );
		} );
	},


	// _infx.content_stream.post_update
	// this function is called after any changes to the content stream data structure have
	// been made, it's vital we keep various indexes and state variables in check with the
	// data we have to ensure all the events have the correct data to work with.
	post_update: function( last_index ){
		var _self = this;

		// set the last index we received - [infinite-scrolling]
// 		_self.state.lastIndexReceived = context.articles[ context.articles.length - 1 ].index;
		_self.state.lastIndex = last_index;

		// fire the scrolling event, to update the various state variables
		_self.on_scroll_event( $(window) );

		// unlock the filtering
		_self.locked = false;

		// trigger a custom event so other elements know we've just updated
		$( _self.selectors.system ).trigger( "content:update" );
	},


	// _infx.content_stream.get_data
	// this function deals with all calls to the content stream widget the opt_callback
	// argument can be set to a function which will be executed with the data returned
	// from the backend widget.
	get_data: function ( params, opt_callback ) {
		var _self = this;

		var contentFilters = _self.storage( 'load', undefined, true );
		$.extend( params, { widget: 'widget-content-stream.pl', state: contentFilters, valid_json: 1 } );

		$.ajax( {
			url: _infx.scripts.infxsystem.widget,
			type: 'post',
			data: params,
			dataType: 'json',
			success: function( data ) {
				if( typeof opt_callback === 'function' ){
					opt_callback( data );
					// always check if primary-filter-all is selected, if so, apply no-opacity to others
					if( $( _self.selectors.system ).find(".primary-filter-all.selected").length === 1 ) {
						$( _self.selectors.system ).find(".primary-filter").not(".selected").addClass("no-opacity");
					}
				}else{
					console.log( data );
				}
			}
		} );
	},


	// _infx.content_stream.compiler
	// simple handlebars compiler wrapper we could make this into some form of support
	// library for handlebars as it's fairly generic
	// template & target can be a JQ selector or a JS pointer to a DOM element, or even a JQ element
	compiler: function( template, target, context, append ){
		var template = Handlebars.compile( $( template ).html() );
		if ( typeof append != 'undefined' && append === true ) {
			var itemsToReplace = $( _self.selectors.items ).slice( parseInt(context.first) , parseInt(context.first) + context.articles.length );
			itemsToReplace.find(".spinner-loader").addClass("shrink");
			setTimeout( function() {
				itemsToReplace.remove();
				$( _self.selectors.items ).eq( parseInt(context.first) - 1 ).after( template( context ) );
			}, 500 );
		} else {
			$( target ).html( template( context ) );
		}
	}
};
// end content stream filtering system +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+

// initialise the filtering system
$( document ).ready( function(){
	_infx.content_stream.init();
} );
