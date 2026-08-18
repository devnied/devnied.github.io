$(function(){
	// define reverse jquery function
	jQuery.fn.reverse = [].reverse;

	function htmlEncode(value){
	  return $('<div/>').text(value).html();
	}

	var selected;

	$(".menu a").reverse().each(function(){
		if (window.location.pathname.match("^"+$(this).attr('href')) ){
			$(this).addClass("active");
			selected = $(this);
			return false;
		}
	});

	if ( !!navigator.userAgent.match(/(iPad|iPhone|iPod)/g) ){
		$("body").scrollTop(1);
	}

	// Email
	$(".mail").attr("href","mai"+"lto"+":mx"+"julien"+"@"+"gmail"+"."+"com");

	// <details> has no built-in light dismiss: without this the language list
	// stays open until you click the summary again.
	$(document).on("click", function(e){
		$("details.cc-langs-toggle[open]").each(function(){
			if ( !this.contains(e.target) ){
				this.removeAttribute("open");
			}
		});
	});

	$(document).on("keyup", function(e){
		if ( e.key === "Escape" ){
			$("details.cc-langs-toggle[open]").removeAttr("open");
		}
	});

	$( ".back" ).click(function() {
	  	window.location = selected.attr('href');
	});


	// iOS WebApp
	if ( navigator.standalone ){
		$("a").click(function (event) {
			if ( $(this).attr("href").indexOf("/") === 0) {
				event.preventDefault();
				window.location = $(this).attr("href");
			}
		});
    }


    // Platform filter (home page)
    var filter = $(".app-filter");
    if ( filter.length ){
    	var cards = $(".app-card");

    	function runsOn(card, platform){
    		return platform === "all" ||
    			String($(card).data("platform")).split(" ").indexOf(platform) !== -1;
    	}

    	// The counts ship in the markup so a crawler reads them; this only keeps
    	// them honest if a card is added and the number is not.
    	filter.find(".app-filter-btn").each(function(){
    		var platform = $(this).data("platform");
    		var count = cards.filter(function(){ return runsOn(this, platform); }).length;
    		$(this).find(".app-filter-count").text(count);
    	});

    	filter.removeAttr("hidden");

    	filter.on("click", ".app-filter-btn", function(){
    		var platform = $(this).data("platform");

    		filter.find(".app-filter-btn").removeClass("is-on").attr("aria-pressed", "false");
    		$(this).addClass("is-on").attr("aria-pressed", "true");

    		cards.each(function(){
    			$(this).prop("hidden", !runsOn(this, platform));
    		});
    	});
    }


    // Tag page
    if (window.location.pathname.match("^/tag/") ){
			$("h1").html("TAG " + htmlEncode(window.location.hash));

			 function tagDisplay(context,e){
			 	var tag = e;
			 	if (tag == null){
			 		tag = window.location.hash;
			 	}
			 	tag = tag.toLowerCase();

				if ( $(context).attr("rel").toLowerCase().indexOf(tag+",") === -1 ){
					$(context).hide();
				}else{
					$(context).show();
				}
			}

			$(".posts li").each(function(){
					tagDisplay(this,null);
			});

			$("a.tag").click(function(){
				var tag = this.hash;
				$("h1").html("TAG " + htmlEncode(tag));
				$(".posts li").each(function(){
					tagDisplay(this,tag);
				});
			});

    }

});
