---
layout: post
title:  "Transformation de bitmap avec Android"
date:   2013-08-10 00:13:37
categories: projets
img: /images/Android/cover.jpg
tags: Android Bitmap
desc: AndroidBitmapTransform est une librairie permettant de faciliter la manipulation des bitmaps avec Android
---
##Introduction

[AndroidBitmapTransform] est une librairie permettant de faciliter la manipulation des bitmaps avec Android<br/>
Version Actuelle : 1.0.0

##Utilisation

Cette librairie est trés simple à utiliser, il suffit d'appeler la méthode BitmapTransform.createBitmap() avec les paramètres souhaités.

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


###Exemple de multiplication entre deux bitmaps
{% highlight java %}
ImageView view = (ImageView) findViewById(R.id.bitmapResult);
Bitmap bitmap = BitmapTransform.createBitmap(this,R.drawable.dst,
				R.drawable.src, PorterDuff.Mode.MULTIPLY, true, false);
view.setImageBitmap(bitmap);
{% endhighlight %}
<br/>
###Exemple d'ajout de deux bitmaps
{% highlight java %}
ImageView view = (ImageView) findViewById(R.id.bitmapResult);
Bitmap bitmap = BitmapTransform.createBitmap(this,R.drawable.dst,
				R.drawable.src, PorterDuff.Mode.ADD, true, false);
view.setImageBitmap(bitmap);
{% endhighlight %}
<br/>
###Liste des modes de fusion

<img src="/images/AndroidBitmapTransform/Xfermodes.png" />
##Maven
{% highlight xml %}
<dependency>
  <groupId>com.github.devnied.AndroidBitmapTransform</groupId>
  <artifactId>library</artifactId>
  <version>1.0.0</version>
</dependency>
{% endhighlight %}

##Liens Utiles

Lien du projet sur GitHub: [AndroidBitmapTransform]

[AndroidBitmapTransform]: https://github.com/devnied/AndroidBitmapTransform "Source du projet sur GitHub"