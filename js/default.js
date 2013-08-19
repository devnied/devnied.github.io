$(function(){
	// define reverse jquery function
	jQuery.fn.reverse = [].reverse;
	
	var selected;

	$(".menu a").reverse().each(function(){
		if (window.location.pathname.match("^"+$(this).attr('href')) ){
			$(this).addClass("active");
			selected = $(this);
			return false;
		}
	});
	
	if ( navigator.userAgent.match(/(iPad|iPhone|iPod)/g) ? true : false ){
		$("body").scrollTop(1);
	}
	
	// Email
	$(".mail").attr("href","mai"+"lto"+":mx"+"julien"+"@"+"gmail"+"."+"com");
	
	$( ".back" ).click(function() {
	  	window.location = selected.attr('href');
	});
	
	
	// iOS WebApp
	if ( navigator.standalone ){
		$("a").click(function (event) {
			if ( $(this).attr("href").indexOf("/") == 0) {
				event.preventDefault();
				window.location = $(this).attr("href");
			}
		});
    }
    
    
    // Tag page
    if (window.location.pathname.match("^/tag/") ){
		$("h1 span").html("TAG " + window.location.hash);
		
		 function tagDisplay(context,e){
		 	var tag = e;
		 	if (tag == null){
		 		tag = window.location.hash;
		 	}
		 	
			if ( $(context).attr("rel").indexOf(tag+",") == -1 ){
				$(context).hide();
			}else{
				$(context).show();
			}
		}
		
		$(".posts li").each(function(){
				tagDisplay(this,null);
		});
		
		$(".posts a,.tags a").click(function(){
			var tag = this.hash;
			$("h1 span").html("TAG " + tag);
			$(".posts li").each(function(){
				tagDisplay(this,tag);
			});
		});
		
    }

});