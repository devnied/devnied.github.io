---
layout: post
title:  "Secure an Android time based application"
date:   2013-08-15
categories: articles
img: /images/secure-time-app/cover.jpg
copy: thinkpanama
comment: true
tags: Android Time
desc: Many games works with waiting time longer or shorter depending on user actions, payments, transport, client management applications have a business model based on accurate timing information.
---
##Introduction
More and more mobile applications are based on time to work. 
Many games works with waiting time longer or shorter depending on user actions, payments, transport, client management applications have a business model based on accurate timing information.
> Remember that time is money

In game to reduce waiting time between stages it's possible to pay.<br/>
How validate something, like discount ticket with wrong date and time ?<br/>
How manage client loyalty with wrong subscription date ?<br/>

I will try to respond to this question, how synchronized time can be secured on Android devices ? 
## Problems

Actually, on a mobile device, the time is not considered as a critical service thus users can change it easily.
On the Android platform, date and time can be modified/updated with 3 different ways:
 
 * If the android platform, is connected to a mobile network, this network provided time to Android.
 * Otherwise Android receive NTP notifications from Google server.
 * Manually the user can change the date and the time of his device.

The third way is the major problem of Android time based application because the JAVA API provided by Android can't allow applications to know the time sync with network provider or Google NTP without user modifications.

## Solutions

### Simple but not secure
The first approach we can made is to save the date and time value when the application start and watch each modifications of system date.<br/>
 ut the user can stop an application and modify the date/time manually; if the application is stop we can’t detect user's modifications.<br/>

### The better one
The other solution is to synchronized date and time with a server and used the SystemClock class in the Java API.<br/>
This class provided some methods to manage system date.<br/>
The most important method for us is [elapsedRealtime]; this method provided the number of milliseconds since the Android platform boot and it was based on clock ticks and not on the system date thus user date/time modifications haven't any impacts on the returned value.
{% highlight java %}
SystemClock.elapsedRealtime();
{% endhighlight %}

Sample class to use the second solution: 

{% highlight java %}
/**
 * Class used to get the real time based of the server sync date
 * @author Julien MILLAU
 */
public class SecureDate {

	/**
	 *  Date sync with server
	 */
	private Date mServerDate;
	
	/**
	 * Number of millisecond since boot
	 */
	private long mElapsedRealtime;

	/**
	 * Singleton instance
	 */
	private static final SecureDate INSTANCE = new SecureDate();

	/**
	 * Get the singleton instance of this class
	 * @return the unique instance of this class
	 */
	public static SecureDate getInstance() {
		return INSTANCE;
	}

	/**
	 * Method used to obtain the real date based on the server date
	 * if the server date was sync
	 * @return the actual secure time
	 */
	public Date getDate() {
		Date current = mServerDate;
		if (current == null) {
			current = Calendar.getInstance(Locale.ENGLISH).getTime();
		} else {
			current.setTime(current.getTime() 
					+ (SystemClock.elapsedRealtime() - mElapsedRealtime));
		}
		return current;
	}
	
	/**
	 * Method used to know if the date is sync with the server
	 * @return true if the serverDate is sync false otherwise
	 */
	public boolean isSyncDate(){
		return mServerDate != null;
	}

	/**
	 * Method used to init the server date
	 * @param pServerDate the sync server date
	 */
	public void initServerDate(final Date pServerDate) {
		mElapsedRealtime = SystemClock.elapsedRealtime();
		mServerDate = pServerDate;
	}

}
{% endhighlight %}

Usage of SecureDate class

{% highlight java %}
// sync date with server
Date serverDate = ...;
// init realDate instance
SecureDate.getInstance().initServerDate(serverDate);

// Each time you need to get the secure real date
Date date = SecureDate.getInstance().getDate();

{% endhighlight %}

## Conclusion

Actually, to secure date and time on Android we need a connection to a server on each first launch of an application to get the real current date and avoid manuals user modifications.


[elapsedRealtime]: http://developer.android.com/reference/android/os/SystemClock.html#elapsedRealtime() "Android developer"