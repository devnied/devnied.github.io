$(function(){

	$(".menu a").each(function(){
		if (window.location.pathname ==  $(this).attr('href') ){
			$(this).addClass("active");
			return false;
		}
	});
	
	if ( navigator.userAgent.match(/(iPad|iPhone|iPod)/g) ? true : false ){
		$("body").scrollTop(1);
	}
	
	$(".mail").attr("href","mailto:mxjulien@gmail.com");

});