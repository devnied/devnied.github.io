---
layout: post
title:  "Bitmap transformation on Android"
date:   2013-08-10 00:13:37
categories: articles
img: /images/Android/cover.jpg
tags: Android Bitmap
desc: AndroidBitmapTransform is an useful library to do Bitmap transformation on Android?
---
## Summary

[AndroidBitmapTransform] is an useful library to do Bitmap transformation on Android.<br/>
Current version : 1.0.0

## How use it

It is very easy to get started with AndroidBitmapTransform:

### Prototype

{% highlight java %}
/**
 * Method to create a Bitmap with the specified mode
 * @param pDst the destination bitmap
 * @param pSrc the source bitmap
 * @param pMode the selected PorterDuff mode
 * @param pScale true to scale source bitmap to destination
 * @param pNewInstance boolean to indicate if this method can modify the Bitmap parameters
 * @return the created bitmap
 */
public static Bitmap createBitmap(final Bitmap pDst, final Bitmap pSrc,
		final PorterDuff.Mode pMode, final boolean pScale,
		final boolean pNewInstance)
{% endhighlight %}

### Multiplication of two bitmaps

{% highlight java %}
ImageView view = (ImageView) findViewById(R.id.bitmapResult);
Bitmap bitmap = BitmapTransform.createBitmap(this,R.drawable.dst,
				R.drawable.src, PorterDuff.Mode.MULTIPLY, true, false);
view.setImageBitmap(bitmap);
{% endhighlight %}

### Addition of two bitmaps

{% highlight java %}
ImageView view = (ImageView) findViewById(R.id.bitmapResult);
Bitmap bitmap = BitmapTransform.createBitmap(this,R.drawable.dst,
				R.drawable.src, PorterDuff.Mode.ADD, true, false);
view.setImageBitmap(bitmap);
{% endhighlight %}

### Fusion mode

<img src="/images/AndroidBitmapTransform/Xfermodes.png" />

##Maven

{% highlight xml %}
<dependency>
  <groupId>com.github.devnied.AndroidBitmapTransform</groupId>
  <artifactId>library</artifactId>
  <version>1.0.0</version>
</dependency>
{% endhighlight %}

## Useful links

Project link on GitHub: [AndroidBitmapTransform]

[AndroidBitmapTransform]: https://github.com/devnied/AndroidBitmapTransform "Project source on GitHub"
