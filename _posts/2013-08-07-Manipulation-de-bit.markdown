---
layout: post
title:  "Manipulation de bit en java (Bit-lib4j)"
date:   2013-08-07 00:13:37
categories: projects
img: /images/bit-manipulation/cover.jpg
tags: Java Bit
desc: Librairie permettant de facilité la lecture d’octet (byte) en java, j’ai créé une librairie JAVA permettant de lire et d’écrire depuis/dans un tableau d’octet les différents types JAVA en spécifiant la taille souhaitée.
---

## Introduction

La manipulation de bits en java n’est pas aussi aisée qu’en C/C++ ou que dans d’autre language car tous les types JAVA sont signés.<br/><br/>
Afin de facilité la lecture d’octet (byte) en java, j’ai créé une librairie JAVA permettant de lire et d’écrire depuis/dans un tableau d’octet les différents types JAVA en spécifiant la taille souhaitée.<br/><br/>
Cette librairie est open-source et disponible sur [GitHub].

## Utilisation

### Lecture des données

{% highlight java %}
byte[] array = new byte[]{0x12,0x25}
BitUtils bit = new BitUtils(array);
int res = bit.getNextInteger(4); // read the first 4 bits to an integer
{% endhighlight %}

### Ecriture des données

{% highlight java %}
BitUtils bit = new BitUtils(8);
bit.setNextInteger(3,3); // set an integer on 3 bits
bit.setNextInteger(1,5); // set one value on 5 bits

// Result
bit.getData();      // return 0x61  (0110 0001b)
{% endhighlight %}

## Maven

{% highlight xml %}
<dependency>
  <groupId>com.github.devnied</groupId>
  <artifactId>bit-lib4j</artifactId>
  <version>1.4.12</version>
</dependency>
{% endhighlight %}

## Liens Utiles

Adresse du projet: [https://github.com/devnied/Bit-lib4j]<br/>
Wiki : [https://github.com/devnied/Bit-lib4j/wiki]

[GitHub]: https://github.com/devnied/Bit-lib4j "Page du projet sur GitHub"
[https://github.com/devnied/Bit-lib4j]: https://github.com/devnied/Bit-lib4j "Page du projet sur GitHub"
[https://github.com/devnied/Bit-lib4j/wiki]: https://github.com/devnied/Bit-lib4j/wiki "Wiki du projet"
